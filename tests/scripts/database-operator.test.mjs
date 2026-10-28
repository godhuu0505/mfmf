import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { COLUMNS, SOURCE, FORMAT, BUCKET, ACCOUNT, validateContext, validateBundle,
  diagnostic, sourceContract, importBundle, upgrade, loadBundle, runOperator, setMediaMode, parseImportIdentity, applyBaseline, verifyImport } from "../../scripts/gcp/database-operator.mjs";

const hash=(value)=>createHash("sha256").update(value).digest("hex");
const marker="SENSITIVE_FIXTURE_NEVER_PRINT";
const ageKey="AGE-SECRET-KEY-1"+"A".repeat(58);
const credentials={postgres:"p".repeat(43),migrator:"m".repeat(43),operator:"o".repeat(43)};
const env={CLOUD_RUN_JOB:"mfmf-db-operator",CLOUD_RUN_TASK_INDEX:"0",CLOUD_RUN_TASK_COUNT:"1",CLOUD_RUN_TASK_ATTEMPT:"0",
  MFMF_DB_OPERATION:"inspect",MFMF_DB_OPERATOR_CREDENTIALS:JSON.stringify(credentials)};
const contract={baselineHash:"a".repeat(64)};
function bundle(){
  const tables=Object.fromEntries(Object.keys(COLUMNS).map(name=>[name,[]]));
  tables.record_ranking_project_budget=[{singleton:true,usage_day:"1970-01-01",daily_count:0,lifetime_count:42}];
  return {format:FORMAT,source:{projectRef:SOURCE},authMirror:[{id:"80000000-0000-4000-8000-000000000001",provider_subject:"80000000-0000-4000-8000-000000000001",email:"fixture@example.test",email_verified:true,created_at:"2026-01-01T00:00:00.123456Z",updated_at:"2026-10-28T00:00:00+00:00"}],
    tables,expected:{counts:{auth_users:1,...Object.fromEntries(Object.entries(tables).map(([name,rows])=>[name,rows.length]))}}};
}
function db({mode="frozen",imported=0,badCounts=false,history=[],baselineHash=contract.baselineHash,importHash="b".repeat(64),mediaProblems=0,writeFrozen=mode==="frozen",triggerCount=21,failWriteGate=false,loaded=false,changedCell=false}={}){
  const calls=[];
  const rows={auth_users:loaded?1:0,...Object.fromEntries(Object.keys(COLUMNS).map(name=>[name,name==="record_ranking_project_budget"?1:0]))};
  return {calls,async end(){},async query(sql,params){
    calls.push({sql,params});
    if(sql.startsWith("SELECT name,sha256") && sql.includes("name='baseline'"))return {rows:[{name:"baseline",sha256:baselineHash}]};
    if(sql.startsWith("SELECT name,sha256"))return {rows:history};
    if(sql.startsWith("SELECT current_database"))return {rows:[{db:"mfmf",usr:"mfmf_migrator",version:170005}]};
    if(sql.startsWith("SELECT rolsuper"))return {rows:[{rolsuper:false,rolbypassrls:false}]};
    if(sql.startsWith("SELECT mode,read_backend"))return {rows:[{mode,read_backend:"gcs"}]};
    if(sql.startsWith("SELECT frozen FROM migration_admin.write_state"))return {rows:[{frozen:writeFrozen}]};
    if(sql.startsWith("SELECT count(*)::int n FROM pg_trigger"))return {rows:[{n:triggerCount}]};
    if(sql.startsWith("UPDATE migration_admin.write_state") && failWriteGate)throw new Error(marker);
    if(sql.startsWith("SELECT count(*)::int n FROM migration_admin.imports"))return {rows:[{n:imported}]};
    if(sql.startsWith("SELECT sha256 FROM migration_admin.imports"))return {rows:imported?[{sha256:importHash}]:[]};
    if(sql.includes(" IS NOT DISTINCT FROM "))return {rows:[{n:changedCell?0:1}]};
    if(sql.startsWith("SELECT count(*)::int n FROM auth.users"))return {rows:[{n:rows.auth_users}]};
    const count=/^SELECT count\(\*\)::int n FROM public\.(\w+)/.exec(sql);
    if(count)return {rows:[{n:badCounts?9:rows[count[1]]}]};
    if(sql.startsWith("SELECT daily_count"))return {rows:[{daily_count:0,lifetime_count:0,usage_day:"1970-01-01"}]};
    if(sql.startsWith("DELETE FROM public.record_ranking_project_budget"))rows.record_ranking_project_budget=0;
    const insert=/^INSERT INTO (auth\.users|public\.(\w+)) \(/.exec(sql);
    if(insert)rows[insert[1]==="auth.users"?"auth_users":insert[2]]++;
    if(sql.startsWith("SELECT ("))return {rows:[{n:mediaProblems}]};
    return {rows:[]};
  }};
}

test("context fixes job, single task, first attempt and all credentials",()=>{
  assert.equal(validateContext(env).operation,"inspect");
  for(const change of [{CLOUD_RUN_JOB:"foreign"},{CLOUD_RUN_TASK_COUNT:"2"},{CLOUD_RUN_TASK_ATTEMPT:"1"},
    {GOOGLE_APPLICATION_CREDENTIALS:"/tmp/key"},{PGHOST:"foreign"},{MFMF_DB_OPERATION:"sql"},
    {MFMF_DB_OPERATOR_CREDENTIALS:marker},{MFMF_DB_OPERATION:"bootstrap"},{MFMF_DB_OPERATION:"upgrade"}]) {
    assert.throws(()=>validateContext({...env,...change}),error=>!String(error).includes(marker));
  }
});
test("complete fixed bundle accepts only explicit legacy UUID mapping",()=>assert.equal(validateBundle(bundle()).format,FORMAT));
for(const [name,mutate] of [
  ["foreign source",b=>b.source.projectRef="foreign"],
  ["identity rebinding",b=>b.authMirror[0].provider_subject="other"],
  ["duplicate identity",b=>b.authMirror.push(b.authMirror[0])],
  ["unverified email",b=>b.authMirror[0].email_verified=false],
  ["missing creation time",b=>delete b.authMirror[0].created_at],
  ["null update time",b=>b.authMirror[0].updated_at=null],
  ["timestamp without timezone",b=>b.authMirror[0].created_at="2026-10-28T01:02:03"],
  ["invalid timestamp",b=>b.authMirror[0].updated_at=marker],
  ["unknown schema",b=>b.tables["auth.users"]=[]],
  ["raw SQL",b=>b.sql="drop database mfmf"],
  ["missing column",b=>delete b.tables.record_ranking_project_budget[0].daily_count],
  ["extra column",b=>b.tables.record_ranking_project_budget[0].sql=marker],
  ["count mismatch",b=>b.expected.counts.auth_users=2],
  ["reserved assets",b=>{const row=Object.fromEntries(COLUMNS.media_assets.map(c=>[c,null]));row.state="reserved";b.tables.media_assets=[row];b.expected.counts.media_assets=1;}],
])test(`bundle rejects ${name} without reflecting input`,()=>{const b=bundle();mutate(b);assert.throws(()=>validateBundle(b),error=>!String(error).includes(marker));});

test("import uses parameters, one transaction and only controlled table names",async()=>{
  const b=bundle();b.tables.profiles=[Object.fromEntries(COLUMNS.profiles.map(name=>[name,null]))];
  b.tables.profiles[0].owner_id=b.authMirror[0].id;b.tables.profiles[0].display_name=marker+"');drop table auth.users;--";b.expected.counts.profiles=1;
  const client=db();const result=await importBundle(client,b,"b".repeat(64),contract);
  assert.equal(result.counts.profiles,1);
  assert.equal(client.calls.filter(call=>call.sql==="COMMIT").length,1);
  assert.ok(client.calls.some(call=>call.sql.includes("pg_advisory_xact_lock")));
  assert.ok(client.calls.some(call=>call.sql.startsWith("LOCK TABLE auth.users")));
  assert.ok(client.calls.some(call=>call.params?.some(value=>typeof value==="string"&&value.includes(marker))));
  assert.ok(client.calls.every(call=>!call.sql.includes(marker)));
  const authInsert=client.calls.find(call=>call.sql.startsWith("INSERT INTO auth.users"));
  assert.deepEqual(authInsert.params.slice(-2),[b.authMirror[0].created_at,b.authMirror[0].updated_at]);
  assert.ok(authInsert.sql.includes("created_at,updated_at"));
  assert.ok(client.calls.every(call=>!call.sql.includes("session_replication_role")&&!call.sql.includes("DISABLE TRIGGER")));
});
for(const [name,options] of [["active target",{mode:"gcs"}],["already imported",{imported:1}],["unexpected target rows",{badCounts:true}]]) {
  test(`import refuses ${name} and rolls back`,async()=>{const client=db(options);await assert.rejects(importBundle(client,bundle(),"b".repeat(64),contract));
    assert.ok(client.calls.some(call=>call.sql==="ROLLBACK"));assert.ok(!client.calls.some(call=>call.sql==="COMMIT"));
    assert.ok(!client.calls.some(call=>call.sql.startsWith("INSERT INTO auth.users")));});
}
test("upgrade zero pending means no backup and no DDL",async()=>{
  const root=await mkdtemp(join(tmpdir(),"mfmf-upgrade-"));let backups=0;
  try {const client=db();const result=await upgrade(client,contract,root,async()=>backups++);
    assert.equal(result.applied,0);assert.equal(backups,0);assert.ok(client.calls.every(call=>!call.sql.startsWith("INSERT INTO migration_admin.history")));}
  finally{await rm(root,{recursive:true,force:true});}
});
test("upgrade requires successful backup before any pending SQL and preserves checksum history",async()=>{
  const root=await mkdtemp(join(tmpdir(),"mfmf-upgrade-"));const sql="CREATE TABLE public.fixture(id int);";
  try {
    await mkdir(join(root,"db/gcp/migrations"),{recursive:true});await writeFile(join(root,"db/gcp/migrations/20261028090000_fixture.sql"),sql);
    const client=db();let called=false;
    await upgrade(client,contract,root,async()=>{assert.ok(client.calls.every(call=>call.sql!==sql));called=true;});
    assert.ok(called);assert.ok(client.calls.some(call=>call.sql===sql));
    const failed=db();await assert.rejects(upgrade(failed,contract,root,async()=>{throw new Error(marker);}));
    assert.ok(failed.calls.every(call=>call.sql!==sql));assert.ok(failed.calls.some(call=>call.sql==="ROLLBACK"));
    const drift=db({history:[{name:"20261028090000_fixture.sql",sha256:"c".repeat(64)}]});
    await assert.rejects(upgrade(drift,contract,root,async()=>assert.fail("must not backup")));
  }finally{await rm(root,{recursive:true,force:true});}
});
test("source manifest verifies exact file set and digest",async()=>{
  const root=await mkdtemp(join(tmpdir(),"mfmf-source-contract-"));
  try {
    await mkdir(join(root,"db/gcp"),{recursive:true});await mkdir(join(root,"supabase/migrations"),{recursive:true});
    await writeFile(join(root,"supabase/migrations/1.sql"),"SELECT 1;");
    await writeFile(join(root,"db/gcp/source-migrations.json"),JSON.stringify({"1.sql":hash("SELECT 1;")}));
    for(const name of ["010_identity.sql","020_public.sql","030_permissions.sql"])await writeFile(join(root,"db/gcp",name),"SELECT 1;");
    assert.equal((await sourceContract(root)).baselineHash.length,64);
    await writeFile(join(root,"supabase/migrations/2.sql"),"SELECT 2;");
    await assert.rejects(sourceContract(root));
  }finally{await rm(root,{recursive:true,force:true});}
});
test("generation-pinned encrypted bundle uses age stdin, no secret childenv, cleans ciphertext",async()=>{
  const plain=Buffer.from(JSON.stringify(bundle())),sha=hash(plain),cipher=Buffer.from("age-encryption.org/v1\n- synthetic ciphertext");
  const calls=[];let path,identity;
  const response=async(url)=>{calls.push(String(url));return new Response(String(url).includes("alt=media")?cipher:JSON.stringify({bucket:BUCKET,name:`imports/${sha}.json.age`,generation:"123",size:String(cipher.length)}));};
  const fakeSpawn=(executable,args,options)=>{
    assert.equal(executable,"/usr/bin/age");assert.deepEqual(args.slice(0,3),["--decrypt","--identity","-"]);path=args[3];
    assert.ok(!JSON.stringify(options).includes(ageKey));
    const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.kill=()=>{};
    child.stdin.on("data",chunk=>identity=String(chunk));
    child.stdin.on("finish",async()=>{assert.deepEqual(await readFile(path),cipher);child.stdout.end(plain);child.emit("close",0);});return child;
  };
  const result=await loadBundle({...env,MFMF_DB_BUNDLE_SHA256:sha,MFMF_DB_BUNDLE_GENERATION:"123",MFMF_DB_IMPORT_IDENTITY:`# created: 2026-10-28T00:00:00Z\n# public key: age1synthetic\n${ageKey}\n`},async()=>"fixture-access-token",response,fakeSpawn);
  assert.equal(result.format,FORMAT);assert.equal(identity,ageKey+"\n");assert.equal(calls.length,2);
  assert.ok(calls.every(url=>url.startsWith(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/`)&&url.includes("generation=123")));
  await assert.rejects(readFile(path));
});
test("inspect verifies metadata principal and returns counts only",async()=>{
  let calls=0;const client=db({baselineHash:(await sourceContract()).baselineHash});
  const result=await runOperator({env,startConnector:false,metadataImpl:async()=>async()=>"fixture",
    connectImpl:async(options)=>{calls++;assert.equal(options.user,"mfmf_migrator");assert.ok(options.host.endsWith("mfmf-499612:asia-northeast1:mfmf-db"));return client;}});
  assert.equal(result.operation,"inspect");assert.equal(calls,1);assert.ok(!JSON.stringify(result).includes(credentials.migrator));
  const fetchImpl=async(url)=>new Response(String(url).endsWith("project-id")?"mfmf-499612":String(url).endsWith("numeric-project-id")?"92772745697":"foreign@invalid");
  await assert.rejects(runOperator({env,startConnector:false,fetchImpl,connectImpl:async()=>assert.fail("must not connect")}));
  assert.ok(ACCOUNT.includes("mfmf-db-operator"));
});
test("CLI plan never needs credentials; invalid arguments disclose no input",()=>{
  const plan=spawnSync(process.execPath,["scripts/gcp/database-operator.mjs"],{encoding:"utf8",env:{PATH:process.env.PATH}});
  assert.equal(plan.status,0);assert.equal(JSON.parse(plan.stdout).network,false);
  const bad=spawnSync(process.execPath,["scripts/gcp/database-operator.mjs",marker],{encoding:"utf8",env:{PATH:process.env.PATH}});
  assert.equal(bad.status,1);assert.ok(!bad.stdout.includes(marker)&&!bad.stderr.includes(marker));
  assert.deepEqual(diagnostic(new Error(marker)),{status:"failed",stage:"context"});
});
test("activate verifies import hash/ref integrity then uses operator role and fixed function",async()=>{
  const client=db({imported:1});const result=await setMediaMode(client,contract,"b".repeat(64),"gcs");
  assert.equal(result.changed,true);assert.ok(client.calls.findIndex(c=>c.sql.startsWith("LOCK TABLE"))<client.calls.findIndex(c=>c.sql.endsWith("FOR UPDATE")));
  assert.ok(client.calls.some(c=>c.sql==="SET LOCAL ROLE media_operator"));
  assert.deepEqual(client.calls.find(c=>c.sql==="SELECT public.set_media_storage_mode($1)").params,["gcs"]);
});
for(const [name,options] of [["wrong import hash",{imported:1,importHash:"c".repeat(64)}],["missing import",{}],["broken binding",{imported:1,mediaProblems:1}]]) {
  test(`activate refuses ${name}`,async()=>{const client=db(options);await assert.rejects(setMediaMode(client,contract,"b".repeat(64),"gcs"));
    assert.ok(client.calls.every(c=>!c.sql.startsWith("SELECT public.set_media_storage_mode")));});
}
test("freeze preserves GCS reads and allows in-flight reservation rows to remain private",async()=>{
  const client=db({imported:1,mode:"gcs"});const result=await setMediaMode(client,contract,"b".repeat(64),"frozen");
  assert.equal(result.readBackend,"gcs");assert.deepEqual(client.calls.find(c=>c.sql.startsWith("SELECT (")).params,[true]);
});
test("age-keygen identity comments normalize to exactly one bounded key line",()=>{
  assert.equal(parseImportIdentity(ageKey),ageKey);
  assert.equal(parseImportIdentity(`# created: fixture\r\n# public key: age1fixture\r\n\r\n${ageKey}\r\n`),ageKey);
  for(const bad of [ageKey+"\n"+ageKey,"# key missing\n",ageKey+"\n"+marker,"# "+"x".repeat(512)+"\n"+ageKey,ageKey+"\0",ageKey+"\r",ageKey+"\n\t",`# 日本語\n${ageKey}`]) {
    assert.throws(()=>parseImportIdentity(bad),error=>!String(error).includes(ageKey)&&!String(error).includes(marker));
  }
});

const pristineCatalog={pristine:true,database_owner:true,public_owner:true,schemas:true,public_objects:true,extensions:true,event_triggers:true,existing_app_roles:true};
for(const pristine of [true,false])test(`bootstrap ${pristine?"accepts a pristine existing database":"rejects any existing catalog or role drift"} without reset`,async()=>{
  const calls=[];
  const client={async query(sql,params){calls.push({sql,params});return {rows:sql.includes("AS pristine")?[{...pristineCatalog,pristine}]:[]};}};
  const root=process.cwd();
  const run=()=>applyBaseline(client,{...contract,baseline:"SELECT 1;"},root,credentials,"r".repeat(43));
  if(pristine)await run();else await assert.rejects(run());
  assert.equal(calls.some(call=>call.sql.includes("CREATE ROLE mfmf_owner")),pristine);
  assert.equal(calls.some(call=>call.sql==="COMMIT"),pristine);
  assert.equal(calls.some(call=>call.sql==="ROLLBACK"),!pristine);
  assert.ok(calls.every(call=>!call.sql.includes("DROP DATABASE")&&!call.sql.includes("DROP ROLE")));
  assert.ok(calls.findIndex(call=>call.sql.includes("pg_advisory_xact_lock"))<calls.findIndex(call=>call.sql.includes("AS pristine")));
  assert.ok(calls.every(call=>!call.sql.includes(credentials.migrator)));
});

for(const [field,reason] of Object.entries({database_owner:"database-owner",public_owner:"public-owner",schemas:"schemas",
 public_objects:"public-objects",extensions:"extensions",event_triggers:"event-triggers",existing_app_roles:"existing-app-roles"})) {
 test(`bootstrap catalog emits only fixed ${reason} reason and never mutates a non-pristine target`,async()=>{
  const calls=[];
  const client={async query(sql){calls.push(sql);return {rows:sql.includes("AS pristine")?[{...pristineCatalog,pristine:false,[field]:false,detail:marker}]:[]};}};
  await assert.rejects(applyBaseline(client,{...contract,baseline:"SELECT 1;"},process.cwd(),credentials,"r".repeat(43)),error=>{
   assert.deepEqual(diagnostic(error),{status:"failed",stage:"bootstrap",substage:"catalog",reasons:[reason]});
   assert.ok(!JSON.stringify(error).includes(marker)&&!String(error).includes(marker));return true;
  });
  assert.equal(calls.at(-1),"ROLLBACK");assert.ok(calls.every(sql=>!/CREATE ROLE|COMMIT|DROP /.test(sql)));
 });
}
test("bootstrap rejects absent, null or malformed catalog predicates without reflecting values",async()=>{
 for(const rows of [[],[{...pristineCatalog,schemas:null}],[{...pristineCatalog,public_owner:marker}],[{pristine:true}]]) {
  const calls=[];const client={async query(sql){calls.push(sql);return {rows:sql.includes("AS pristine")?rows:[]};}};
  await assert.rejects(applyBaseline(client,{...contract,baseline:"SELECT 1;"},process.cwd(),credentials,"r".repeat(43)),error=>{
   assert.deepEqual(diagnostic(error),{status:"failed",stage:"bootstrap",substage:"catalog"});return true;
  });
  assert.ok(calls.every(sql=>!sql.includes("CREATE ROLE")));
 }
});
for(const [substage,match] of [
 ["catalog",sql=>sql.includes("AS pristine")],["roles",sql=>sql.includes("CREATE ROLE mfmf_owner")],
 ["baseline",sql=>sql==="SELECT 1;"],["ledger",sql=>sql.startsWith("CREATE SCHEMA migration_admin")],
 ["password",sql=>sql.startsWith("DO $$ BEGIN EXECUTE format('ALTER ROLE")],["commit",sql=>sql==="COMMIT"],
])test(`bootstrap ${substage} failure exposes SQLSTATE only and rolls back`,async()=>{
 const calls=[];const failure=Object.assign(new Error(marker),{code:"42501",detail:marker,where:marker,query:marker});
 const client={async query(sql){calls.push(sql);if(match(sql))throw failure;return {rows:sql.includes("AS pristine")?[pristineCatalog]:[]};}};
 await assert.rejects(applyBaseline(client,{...contract,baseline:"SELECT 1;"},process.cwd(),credentials,"r".repeat(43)),error=>{
  assert.deepEqual(diagnostic(error),{status:"failed",stage:"bootstrap",substage,sqlstate:"42501"});
  assert.ok(!JSON.stringify(error).includes(marker)&&!String(error).includes(marker));return true;
 });
 assert.equal(calls.at(-1),"ROLLBACK");assert.equal(calls.filter(sql=>sql==="ROLLBACK").length,1);
});
test("bootstrap diagnostic rejects arbitrary exception codes and mutated diagnostic fields",async()=>{
 for(const code of [marker,"42p01","42501\n",42501,"42501 ","P0001:detail"]) {
  const client={async query(sql){if(sql.includes("AS pristine"))throw Object.assign(new Error(marker),{code});return {rows:[]};}};
  await assert.rejects(applyBaseline(client,contract,process.cwd(),credentials,"r".repeat(43)),error=>{
   assert.deepEqual(diagnostic(error),{status:"failed",stage:"bootstrap",substage:"catalog"});
   error.substage=marker;error.sqlstate=marker;error.reasons=[marker];
   assert.deepEqual(diagnostic(error),{status:"failed",stage:"bootstrap"});
   error.stage=marker;assert.deepEqual(diagnostic(error),{status:"failed",stage:"context"});return true;
  });
 }
});

for(const [name,options] of [["mismatched write state",{writeFrozen:false}],["missing ALWAYS guard",{triggerCount:20}]])test(`activate rejects ${name}`,async()=>{
  const client=db({imported:1,...options});await assert.rejects(setMediaMode(client,contract,"b".repeat(64),"gcs"));
  assert.ok(client.calls.every(call=>!call.sql.startsWith("SELECT public.set_media_storage_mode")));
});
test("whole-database freeze and media switch commit together or roll back together",async()=>{
  const client=db({imported:1});const result=await setMediaMode(client,contract,"b".repeat(64),"gcs");
  assert.equal(result.databaseWrites,"enabled");
  assert.deepEqual(client.calls.find(call=>call.sql.startsWith("UPDATE migration_admin.write_state")).params,[false]);
  const lock=client.calls.find(call=>call.sql.startsWith("LOCK TABLE")).sql;
  assert.ok(lock.includes("auth.users")&&lock.includes("public.google_credentials")&&lock.includes("public.media_storage_state"));
  const failed=db({imported:1,failWriteGate:true});await assert.rejects(setMediaMode(failed,contract,"b".repeat(64),"gcs"));
  assert.ok(failed.calls.some(call=>call.sql.startsWith("SELECT public.set_media_storage_mode")));
  assert.ok(failed.calls.some(call=>call.sql==="ROLLBACK"));assert.ok(failed.calls.every(call=>call.sql!=="COMMIT"));
});

test("verify-import requires a pinned generation and identity just like restore-test",()=>{
 const valid={...env,MFMF_DB_OPERATION:"verify-import",MFMF_DB_BUNDLE_SHA256:"b".repeat(64),MFMF_DB_BUNDLE_GENERATION:"1",MFMF_DB_IMPORT_IDENTITY:ageKey};
 assert.equal(validateContext(valid).operation,"verify-import");
 for(const key of ["MFMF_DB_BUNDLE_SHA256","MFMF_DB_BUNDLE_GENERATION","MFMF_DB_IMPORT_IDENTITY"]){const changed={...valid};delete changed[key];assert.throws(()=>validateContext(changed));}
});
test("verify-import reads a stable snapshot and compares every column without DML or DDL",async()=>{
 const client=db({loaded:true,imported:1});const result=await verifyImport(client,bundle(),"b".repeat(64),contract);
 assert.equal(result.comparison,"all-rows-compared");assert.equal(result.readOnly,true);
 assert.ok(client.calls.some(call=>call.sql.startsWith("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")));
 assert.ok(client.calls.findIndex(call=>call.sql.includes("pg_advisory_lock("))<client.calls.findIndex(call=>call.sql.startsWith("BEGIN")));
 const compared=client.calls.filter(call=>call.sql.includes(" IS NOT DISTINCT FROM "));
 assert.equal(compared.length,2);assert.ok(compared[0].sql.includes("created_at IS NOT DISTINCT FROM")&&compared[0].sql.includes("updated_at IS NOT DISTINCT FROM"));
 assert.deepEqual(compared[0].params,Object.values(bundle().authMirror[0]));
 assert.ok(client.calls.every(call=>/^(SELECT|BEGIN|COMMIT)/.test(call.sql)));
 assert.ok(client.calls.at(-1).sql.includes("pg_advisory_unlock("));
});
for(const [name,options] of [["changed cell at equal counts",{changedCell:true}],["extra/missing rows",{badCounts:true}],
 ["missing import ledger",{imported:0}],["wrong import hash",{importHash:"c".repeat(64)}],["wrong baseline",{baselineHash:"d".repeat(64)}],
 ["active database",{mode:"gcs"}],["unfrozen private state",{writeFrozen:false}],["missing write guard",{triggerCount:20}]]){
 test(`verify-import refuses ${name} and releases lock without mutation`,async()=>{
  const client=db({loaded:true,imported:1,...options});
  await assert.rejects(verifyImport(client,bundle(),"b".repeat(64),contract),error=>!String(error).includes(marker));
  assert.ok(client.calls.some(call=>call.sql==="ROLLBACK"));assert.ok(client.calls.every(call=>call.sql!=="COMMIT"));
  assert.ok(client.calls.every(call=>/^(SELECT|BEGIN|ROLLBACK)/.test(call.sql)));
  assert.ok(client.calls.at(-1).sql.includes("pg_advisory_unlock("));
 });
}
