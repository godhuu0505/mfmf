// Fresh, network-none CI fixture only. Models the managed non-superuser postgres
// without mistaking the stock bootstrap-superuser OID for Cloud SQL's postgres.
import assert from "node:assert/strict";
import {Client} from "pg";
import {applyBaseline,diagnostic,runOperator,sourceContract} from "../../scripts/gcp/database-operator.mjs";
const credentials={postgres:"p".repeat(43),migrator:"m".repeat(43),operator:"o".repeat(43)};
const env={CLOUD_RUN_JOB:"mfmf-db-operator",CLOUD_RUN_TASK_INDEX:"0",CLOUD_RUN_TASK_COUNT:"1",CLOUD_RUN_TASK_ATTEMPT:"0",
 MFMF_DB_OPERATOR_CREDENTIALS:JSON.stringify(credentials),MFMF_DATABASE_PASSWORD:"r".repeat(43)};
let connections=0,peak=0,checks=0,stage="fixture";
const check=value=>{assert.ok(value);checks++;};
async function connect(options){
 const client=new Client({...options,host:"127.0.0.1",port:5432});await client.connect();connections++;peak=Math.max(peak,connections);
 check(connections<=2);const end=client.end.bind(client);let ended=false;
 client.end=async()=>{if(ended)return;ended=true;try{await end();}finally{connections--;}};return client;
}
const run=operation=>runOperator({env:{...env,MFMF_DB_OPERATION:operation},startConnector:false,
 metadataImpl:async()=>async()=>"synthetic-token",connectImpl:connect});
async function owner(client){return (await client.query("SELECT pg_get_userbyid(datdba) name FROM pg_database WHERE datname='mfmf'")).rows[0].name;}
try {
 const initial=await connect({user:"postgres",database:"postgres"});
 try{await initial.query("CREATE ROLE fixture_admin LOGIN SUPERUSER;");}finally{await initial.end();}
 const fixture=await connect({user:"fixture_admin",database:"postgres"});
 try {
  await fixture.query("ALTER ROLE postgres RENAME TO fixture_bootstrap;");
  await fixture.query(`CREATE ROLE postgres LOGIN INHERIT NOSUPERUSER NOBYPASSRLS CREATEROLE CREATEDB NOREPLICATION;
   CREATE ROLE cloudsqlsuperuser NOLOGIN NOSUPERUSER NOBYPASSRLS;
   GRANT cloudsqlsuperuser TO postgres WITH INHERIT TRUE, SET TRUE;`);
  await fixture.query("CREATE DATABASE mfmf OWNER cloudsqlsuperuser");
 }finally{await fixture.end();}
 stage="managed-identity";
 const admin=await connect({user:"postgres",database:"mfmf"});
 try {
  const role=(await admin.query("SELECT oid,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user")).rows[0];
  check(role.oid!==10&&!role.rolsuper&&!role.rolbypassrls&&role.rolcreatedb&&role.rolcreaterole);
  check(await owner(admin)==="cloudsqlsuperuser");
  const membership=(await admin.query("SELECT pg_has_role(current_user,'cloudsqlsuperuser','MEMBER') member,pg_has_role(current_user,'cloudsqlsuperuser','USAGE') usage")).rows[0];
  check(membership.member&&membership.usage);
  // This failure occurs after role creation/schema work. All of those writes,
  // including the owner normalization, must roll back together.
  stage="atomic-rollback";const contract=await sourceContract();
  await assert.rejects(applyBaseline(admin,{...contract,baseline:contract.baseline+"\nSELECT 1/0;"},"/app",credentials,env.MFMF_DATABASE_PASSWORD),error=>{
   check(diagnostic(error).substage==="baseline"&&diagnostic(error).sqlstate==="22012");return true;
  });
  check(await owner(admin)==="cloudsqlsuperuser");
  check((await admin.query("SELECT count(*)::int n FROM pg_roles WHERE rolname IN ('mfmf_owner','anon','authenticated','identity_sync','media_operator','authenticator','mfmf_migrator','mfmf_operator')")).rows[0].n===0);
  check((await admin.query("SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'")).rows[0].n===0);
 }finally{await admin.end();}
 stage="bootstrap";check((await run("bootstrap")).databaseOwnerNormalized===true);
 stage="inspect";const state=await run("inspect");check(state.databaseWrites==="frozen"&&state.mediaWrites==="frozen"&&!state.imported);
 stage="role-boundaries";
 const proof=await connect({user:"postgres",database:"mfmf"});
 try {
  check(await owner(proof)==="postgres");
  const roles=(await proof.query(`SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,
   pg_has_role(oid,'cloudsqlsuperuser','MEMBER') managed_admin FROM pg_roles
   WHERE rolname IN ('mfmf_owner','anon','authenticated','identity_sync','media_operator','authenticator','mfmf_migrator','mfmf_operator')`)).rows;
  check(roles.length===8&&roles.every(role=>!role.rolsuper&&!role.rolcreatedb&&!role.rolcreaterole&&!role.rolbypassrls&&!role.managed_admin));
 }finally{await proof.end();}
 const runtime=await connect({user:"authenticator",database:"mfmf",password:env.MFMF_DATABASE_PASSWORD});
 try {
  for(const sql of ["SET ROLE mfmf_owner","SET ROLE cloudsqlsuperuser","CREATE ROLE forbidden_fixture","CREATE TABLE public.forbidden_fixture(id int)"]){
   await assert.rejects(runtime.query(sql),error=>error.code==="42501");checks++;
  }
  await runtime.query("SET ROLE authenticated");
  check((await runtime.query("SELECT count(*)::int n FROM public.daycare_records")).rows[0].n===0);
  await assert.rejects(runtime.query("SELECT public.sync_identity('forbidden',NULL,false,true)"),error=>error.code==="42501");checks++;
 }finally{await runtime.end();}
 stage="no-reuse";await assert.rejects(run("bootstrap"),error=>diagnostic(error).substage==="catalog");checks++;
 console.log(JSON.stringify({managedBootstrapProof:"passed",checks,nonSuperuserAdmin:true,ownerNormalizationRollbackVerified:true,runtimeRolesNotElevated:true,peakConnections:peak}));
}catch(error){console.error(JSON.stringify({managedBootstrapProof:"failed",stage,operatorStage:diagnostic(error).stage,
 ...(diagnostic(error).substage?{operatorSubstage:diagnostic(error).substage}:{}),...(diagnostic(error).sqlstate?{sqlstate:diagnostic(error).sqlstate}:{})}));process.exitCode=1;}
