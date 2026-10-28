// Runs only in the operator image joined to a disposable network-none DB
// namespace by run-operator-tests.py. No API, metadata, source archive or env file.
import assert from "node:assert/strict";
import { Client } from "pg";
import { COLUMNS,FORMAT,SOURCE,runOperator } from "../../scripts/gcp/database-operator.mjs";
const credentials={postgres:"p".repeat(43),migrator:"m".repeat(43),operator:"o".repeat(43)};
const env={CLOUD_RUN_JOB:"mfmf-db-operator",CLOUD_RUN_TASK_INDEX:"0",CLOUD_RUN_TASK_COUNT:"1",CLOUD_RUN_TASK_ATTEMPT:"0",
 MFMF_DB_OPERATOR_CREDENTIALS:JSON.stringify(credentials),MFMF_DATABASE_PASSWORD:"r".repeat(43),
 MFMF_DB_BUNDLE_SHA256:"a".repeat(64),MFMF_DB_BUNDLE_GENERATION:"1",MFMF_DB_IMPORT_IDENTITY:"AGE-SECRET-KEY-1"+"A".repeat(58)};
const timestamp="2026-10-28T00:00:00+00:00";
const id=(n)=>`80000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const tables=Object.fromEntries(Object.keys(COLUMNS).map(name=>[name,[]]));
const add=(name,values)=>tables[name].push({...Object.fromEntries(COLUMNS[name].map(column=>[column,null])),...values});
for(let i=1;i<=2;i++){
 add("households",{id:id(10+i),name:`fixture ${i}`,created_at:timestamp});
 add("household_members",{household_id:id(10+i),user_id:id(i),role:"owner",created_at:timestamp});
}
add("daycare_records",{id:id(21),owner_id:id(1),household_id:id(11),record_date:"2026-10-28",body:"synthetic operator fixture",
 created_at:timestamp,updated_at:timestamp,source:"daycare",author:"",guest_visible:false,status:"done",overrides_rule:false});
for(let i=31;i<=32;i++)add("media_assets",{id:id(i),kind:"photo",entity_id:id(21),household_id:id(11),owner_id:id(1),created_by:id(1),
 incoming_key:`_incoming/${id(i)}`,final_key:`${id(11)}/${id(21)}/${id(i)}`,byte_size:123,content_type:"image/jpeg",
 state:i===31?"ready":"deleted",expires_at:timestamp,generation:String(i),created_at:timestamp,
 deleted_at:i===32?timestamp:null,is_legacy:false});
add("record_photos",{id:id(31),record_id:id(21),storage_path:`${id(11)}/${id(21)}/${id(31)}`,created_at:timestamp,household_id:id(11),media_asset_id:id(31)});
add("google_credentials",{owner_id:id(1),refresh_token_enc:"SYNTHETIC-OPAQUE-CIPHERTEXT",created_at:timestamp,updated_at:timestamp});
add("record_ranking_project_budget",{singleton:true,usage_day:"1970-01-01",daily_count:0,lifetime_count:42});
const bundle={format:FORMAT,source:{projectRef:SOURCE},authMirror:[1,2].map(n=>({id:id(n),provider_subject:id(n),email:`fixture${n}@example.test`,email_verified:true,created_at:"2026-01-01T00:00:00.123456Z",updated_at:timestamp})),
 tables,expected:{counts:{auth_users:2,...Object.fromEntries(Object.entries(tables).map(([name,rows])=>[name,rows.length]))}}};
let connections=0,peak=0;
const connectImpl=async(options)=>{
 const client=new Client({...options,host:"127.0.0.1",port:5432});await client.connect();connections++;peak=Math.max(peak,connections);
 assert.ok(connections<=2,"operator connection ceiling");let ended=false;
 const end=client.end.bind(client);client.end=async()=>{if(ended)return;ended=true;try{await end();}finally{connections--;}};
 return client;
};
async function runtime(role,sql,params=[],expectedCode){
 const client=await connectImpl({user:"authenticator",database:"mfmf",password:"r".repeat(43)});
 try {
  await client.query(`BEGIN; SET LOCAL ROLE ${role};`);
  await client.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify(role==="authenticated"?{role,sub:id(1)}:{role})]);
  if(expectedCode)await assert.rejects(client.query(sql,params),error=>error?.code===expectedCode);
  else return (await client.query(sql,params)).rows;
 }finally{await client.query("ROLLBACK").catch(()=>{});await client.end();}
}
async function frozenProof(){
 const mirrored=await runtime("identity_sync","SELECT public.sync_identity($1,$2,true,false) id",[id(1),"fixture1@example.test"]);
 assert.equal(mirrored[0].id,id(1));
 await runtime("identity_sync","SELECT public.sync_identity($1,$2,true,false)",[id(1),"changed@example.test"],"55000");
 await runtime("identity_sync","SELECT public.sync_identity('new-frozen-user','new@example.test',true,true)",[],"55000");
 await runtime("authenticated","UPDATE public.daycare_records SET body=body WHERE id=$1",[id(21)],"55000");
 await runtime("authenticated","DELETE FROM public.daycare_records WHERE id=$1",[id(999)],"55000");
 await runtime("authenticated","INSERT INTO public.profiles(owner_id) VALUES($1)",[id(1)],"55000");
 await runtime("authenticated","SELECT public.reserve_record_ranking($1)",[id(11)],"55000");
 await runtime("authenticated","UPDATE migration_admin.write_state SET frozen=false",[],"42501");
 assert.equal((await runtime("authenticated","SELECT count(*)::int n FROM public.daycare_records"))[0].n,1);
}
async function failedActivationProof(){
 const admin=await connectImpl({user:"postgres",database:"mfmf"});
 try {
  await admin.query("CREATE FUNCTION migration_admin.reject_fixture_gate() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture rejection' USING ERRCODE='55000'; END$$; CREATE TRIGGER reject_fixture_gate BEFORE UPDATE ON migration_admin.write_state FOR EACH STATEMENT EXECUTE FUNCTION migration_admin.reject_fixture_gate();");
  await assert.rejects(run("activate"));
  const state=(await admin.query("SELECT s.mode,w.frozen FROM public.media_storage_state s CROSS JOIN migration_admin.write_state w")).rows;
  assert.deepEqual(state,[{mode:"frozen",frozen:true}]);
 }finally{await admin.query("DROP TRIGGER IF EXISTS reject_fixture_gate ON migration_admin.write_state; DROP FUNCTION IF EXISTS migration_admin.reject_fixture_gate();");await admin.end();}
}
async function staleSnapshotFreezeProof(){
 const client=await connectImpl({user:"authenticator",database:"mfmf",password:"r".repeat(43)});
 try {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ; SET LOCAL ROLE authenticated;");
  await client.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({role:"authenticated",sub:id(1)})]);
  await client.query("SELECT count(*) FROM public.daycare_records");
  assert.equal((await run("freeze")).databaseWrites,"frozen");
  await assert.rejects(client.query("UPDATE public.daycare_records SET body=body WHERE id=$1",[id(21)]),error=>error?.code==="40001");
 }finally{await client.query("ROLLBACK").catch(()=>{});await client.end();}
}
const run=(operation)=>runOperator({env:{...env,MFMF_DB_OPERATION:operation,MFMF_DB_DEPLOY_SHA:"f".repeat(40)},
 startConnector:false,metadataImpl:async()=>async()=>"synthetic-token",bundleImpl:async()=>bundle,connectImpl});
try {
 const provision=await connectImpl({user:"postgres",database:"postgres"});
 await provision.query("CREATE DATABASE mfmf");await provision.end();
 assert.equal((await run("bootstrap")).baseline,"applied");
 assert.equal((await run("inspect")).imported,false);
 assert.equal((await run("restore-test")).restore,"all-rows-compared");
 assert.equal((await run("migrate")).counts.auth_users,2);
 assert.equal((await run("verify-import")).comparison,"all-rows-compared");
 const alteration=await connectImpl({user:"postgres",database:"mfmf"});
 try {
  await alteration.query("UPDATE public.record_ranking_project_budget SET lifetime_count=$1 WHERE singleton",[43]);
  await assert.rejects(run("verify-import"));
  await alteration.query("UPDATE public.record_ranking_project_budget SET lifetime_count=$1 WHERE singleton",[42]);
 }finally{await alteration.end();}
 assert.equal((await run("verify-import")).comparison,"all-rows-compared");
 const result=await run("inspect");assert.equal(result.imported,true);assert.equal(result.mediaWrites,"frozen");assert.equal(result.databaseWrites,"frozen");
 await frozenProof();
 await assert.rejects(run("migrate"));
 assert.equal((await run("upgrade")).applied,0);
 await failedActivationProof();
 assert.equal((await run("activate")).databaseWrites,"enabled");
 await assert.rejects(run("verify-import"));
 await runtime("authenticated","UPDATE public.daycare_records SET body=body WHERE id=$1",[id(21)]);
 await runtime("identity_sync","SELECT public.sync_identity($1,$2,true,false)",[id(1),"changed@example.test"]);
 await staleSnapshotFreezeProof();
 await frozenProof();
 const admin=await connectImpl({user:"postgres",database:"postgres"});
 assert.equal((await admin.query("SELECT count(*)::int n FROM pg_database WHERE datname='mfmf_restore_probe'")).rows[0].n,0);
 assert.equal((await admin.query("SELECT count(*)::int n FROM pg_roles WHERE rolname='mfmf_restore_proof'")).rows[0].n,0);await admin.end();
 console.log(JSON.stringify({operatorProof:"passed",operations:8,peakConnections:peak,temporaryResourcesRemoved:true}));
}catch(error){console.error(JSON.stringify({operatorProof:"failed",stage:error?.stage??"assertion"}));process.exitCode=1;}
