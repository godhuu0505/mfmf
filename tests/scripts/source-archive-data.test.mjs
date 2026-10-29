import test from "node:test";
import assert from "node:assert/strict";
import { COLUMNS,validateBundle } from "../../scripts/gcp/database-operator.mjs";
import { convertIdentityImport } from "../../scripts/gcp/identity-import.mjs";
import { parseSourceArchiveData,decodeCopyField,normalizeArchiveTimestamp,SourceArchiveError } from "../../scripts/gcp/source-archive-data.mjs";

const PRIVATE="PRIVATE_SOURCE_VALUE_NEVER_PRINT";
const ID="80000000-0000-4000-8000-000000000001";
const AT="2026-10-28 01:02:03.123456+00";
const HASH="$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";
const user={id:ID,email:"fixture@example.test",role:"authenticated",aud:"authenticated",is_anonymous:false,is_sso_user:false,is_super_admin:false,
 deleted_at:null,phone:null,phone_confirmed_at:null,created_at:AT,updated_at:AT,email_confirmed_at:AT,last_sign_in_at:null,
 encrypted_password:HASH,banned_until:null,raw_user_meta_data:{tos_accepted_at:"2026-10-28T00:00:00Z"},raw_app_meta_data:{provider:"email",providers:["email"]}};
const identity={id:"80000000-0000-4000-8000-000000000002",user_id:ID,provider:"email",provider_id:ID,identity_data:{sub:ID,email:user.email,email_verified:true},created_at:AT,updated_at:AT};
const UNSUPPORTED=["mfa_factors","mfa_challenges","mfa_recovery_code_sets","mfa_recovery_codes","webauthn_credentials",
 "webauthn_challenges","custom_oauth_providers","oauth_clients","oauth_authorizations","oauth_consents","oauth_client_states",
 "scim_users","scim_tokens","sso_providers","sso_domains","saml_providers","saml_relay_states","instances"];
const DISCARDED=["sessions","refresh_tokens","flow_state","mfa_amr_claims","one_time_tokens","audit_log_entries","schema_migrations"];
const AUTH_COLUMNS={users:Object.keys(user),identities:Object.keys(identity),mfa_factors:["id","user_id","factor_type","status"],
 ...Object.fromEntries([...UNSUPPORTED.filter(name=>name!=="mfa_factors"),...DISCARDED].map(name=>[name,["id"]]))};
function escape(value){
 if(value===null)return "\\N";
 if(typeof value==="boolean")return value?"t":"f";
 if(typeof value==="object")value=JSON.stringify(value);
 return String(value).replace(/\\/g,"\\\\").replace(/\x08/g,"\\b").replace(/\t/g,"\\t").replace(/\n/g,"\\n").replace(/\r/g,"\\r");
}
function copy(schema,table,columns,rows=[]){return `COPY "${schema}"."${table}" (${columns.map(name=>`"${name}"`).join(", ")}) FROM stdin;\n${rows.map(row=>columns.map(column=>escape(row[column])).join("\t")+"\n").join("")}\\.\n`;}
function fixture({tableRows={},users=[user],identities=[identity],mfa=[],authRows={},extra=""}={}){
 let sql="-- PostgreSQL database dump\nSET statement_timeout = 0;\nSET client_encoding = 'UTF8';\nSET standard_conforming_strings = on;\nSELECT pg_catalog.set_config('search_path', '', false);\n\n";
 for(const [name,columns] of Object.entries(COLUMNS))sql+=copy("public",name,columns,tableRows[name]??[])+"\n";
 sql+=copy("public","media_storage_state",["singleton","mode","read_backend"],[{singleton:true,mode:"frozen",read_backend:"gcs"}]);
 sql+=copy("auth","users",Object.keys(user),users);
 sql+=copy("auth","identities",Object.keys(identity),identities);
 sql+=copy("auth","mfa_factors",["id","user_id","factor_type","status"],mfa);
 for(const [table,columns] of Object.entries(AUTH_COLUMNS)){
  if(!["users","identities","mfa_factors"].includes(table))sql+=copy("auth",table,columns,authRows[table]??[]);
 }
 return sql+extra+"-- PostgreSQL database dump complete\n";
}
const parse=(sql)=>parseSourceArchiveData(Buffer.from(sql));
function rejects(input){assert.throws(()=>parseSourceArchiveData(typeof input==="string"?Buffer.from(input):input),error=>{
 assert.ok(error instanceof SourceArchiveError);assert.equal(error.message,"Source archive data rejected; details withheld.");
 assert.ok(!error.stack.includes(PRIVATE));assert.equal(error.cause,undefined);return true;
});}

test("complete fixed schema preserves exact strings and converts only explicit bool/JSON/time fields",()=>{
 const profile={...Object.fromEntries(COLUMNS.profiles.map(c=>[c,null])),owner_id:ID,display_name:"改行\n\t\\N\n\\.\nDROP TABLE auth.users;",created_at:AT,updated_at:AT};
 const budget={singleton:true,usage_day:"2026-10-28",daily_count:2,lifetime_count:"9007199254740993"};
 const context={message:PRIVATE,nested:[1,false,null]};const feedback={...Object.fromEntries(COLUMNS.feedback.map(c=>[c,null])),context};
 const result=parse(fixture({tableRows:{profiles:[profile],record_ranking_project_budget:[budget],feedback:[feedback]}}));
 assert.equal(result.tables.profiles[0].display_name,profile.display_name);
 assert.equal(result.tables.profiles[0].created_at,AT);
 assert.equal(result.tables.record_ranking_project_budget[0].singleton,true);
 assert.equal(result.tables.record_ranking_project_budget[0].daily_count,"2");
 assert.equal(result.tables.record_ranking_project_budget[0].lifetime_count,"9007199254740993");
 assert.deepEqual(result.tables.feedback[0].context,context);
 assert.equal(result.users[0].created_at,"2026-10-28T01:02:03.123456Z");
 assert.equal(result.users[0].encrypted_password,HASH);
 assert.equal(result.users[0].is_anonymous,false);
 assert.deepEqual(result.identities[0].identity_data,identity.identity_data);
 assert.deepEqual(result.sourceMediaState,{singleton:true,mode:"frozen",read_backend:"gcs"});
});
test("parser feeds converter and exact operator bundle contract without SQL execution",()=>{
 const tables={record_ranking_project_budget:[{singleton:true,usage_day:"1970-01-01",daily_count:0,lifetime_count:0}]};
 const parsed=parse(fixture({tableRows:tables}));const converted=convertIdentityImport({users:parsed.users,identities:parsed.identities,mfaFactors:parsed.mfaFactors,targetUsers:[]});
 assert.equal(converted.authMirror[0].id,ID);
 const bundle={format:"mfmf-gcp-import-v1",source:{projectRef:"aqvmuhqkaqedtxuqwhoq"},authMirror:converted.authMirror,tables:parsed.tables,expected:{counts:{auth_users:parsed.users.length,...Object.fromEntries(Object.entries(parsed.tables).map(([name,rows])=>[name,rows.length]))}}};
 assert.equal(validateBundle(bundle),bundle);
});
test("discarded auth session/token tables are structurally checked but never returned",()=>{
 const result=parse(fixture({authRows:{sessions:[{id:PRIVATE}]}}));
 assert.equal(JSON.stringify(result).includes(PRIVATE),false);assert.equal(result.sessions,undefined);
});
test("nonempty MFA is rejected during archive parsing before any converter payload",()=>{
 rejects(fixture({mfa:[{id:ID,user_id:ID,factor_type:"totp",status:"verified"}]}));
 assert.deepEqual(parse(fixture()).mfaFactors,[]);
});
test("fixed inventory covers 27 tables with 18 empty-required tables",()=>{
 assert.equal(Object.keys(AUTH_COLUMNS).length,27);assert.equal(UNSUPPORTED.length,18);
});
for(const table of UNSUPPORTED)test(`archive rejects any row in unsupported auth ${table}`,()=>{
 const empty=copy("auth",table,AUTH_COLUMNS[table]);
 for(const marker of [PRIVATE,null])rejects(fixture().replace(empty,copy("auth",table,AUTH_COLUMNS[table],
  [Object.fromEntries(AUTH_COLUMNS[table].map(column=>[column,marker]))])));
});
for(const table of DISCARDED)test(`explicit archive-only auth ${table} may be nonempty but never returned`,()=>{
 const parsed=parse(fixture({authRows:{[table]:[{id:PRIVATE},{id:null}]}}));
 assert.equal(JSON.stringify(parsed).includes(PRIVATE),false);assert.equal(Object.hasOwn(parsed,table),false);
});
for(const [table,columns] of Object.entries(AUTH_COLUMNS)){
 test(`archive requires auth ${table} COPY even when empty`,()=>{
  const base=fixture({users:[],identities:[]});rejects(base.replace(copy("auth",table,columns),""));
 });
 test(`archive rejects duplicate auth ${table} COPY`,()=>rejects(fixture()+copy("auth",table,columns)));
}
test("unknown auth tables are refused whether empty or populated",()=>{
 for(const table of ["future_credential","sso_sessions"]){
  rejects(fixture()+copy("auth",table,["id"]));rejects(fixture()+copy("auth",table,["id"],[{id:PRIVATE}]));
 }
});
test("nonzero transient and migration-history inventories do not imply unsupported credentials",()=>{
 const counts={sessions:6,refresh_tokens:47,flow_state:12,mfa_amr_claims:6,schema_migrations:82};
 const authRows=Object.fromEntries(Object.entries(counts).map(([table,count])=>[table,Array.from({length:count},()=>({id:PRIVATE}))]));
 const parsed=parse(fixture({authRows}));
 const converted=convertIdentityImport({users:parsed.users,identities:parsed.identities,mfaFactors:parsed.mfaFactors,targetUsers:[]});
 assert.equal(converted.summary.users,1);assert.equal(JSON.stringify(parsed).includes(PRIVATE),false);
});
test("paired pg_dump restrict metadata is inert and matched",()=>{
 const result=parse("\\restrict Abc123\n"+fixture()+"\\unrestrict Abc123\n");assert.equal(result.users.length,1);
 rejects("\\restrict Abc123\n"+fixture()+"\\unrestrict Wrong\n");rejects("\\restrict Abc123\n"+fixture());
});
for(const [raw,expected] of [["\\N",null],["\\\\N","\\N"],["",""] ,["a\\tb\\nc\\rd\\be\\ff\\vg\\\\h","a\tb\nc\rd\be\ff\vg\\h"],["\\101\\x42","AB"],["\\343\\201\\202","あ"],["\\xe3\\x81\\x82","あ"]]){
 test(`COPY escape case ${JSON.stringify(raw)}`,()=>assert.equal(decodeCopyField(raw),expected));
}
for(const raw of ["\\q","\\","\\x","\\400","\\000","\\xff","\\Nextra","\\.","\ud800"]){
 test("invalid COPY escape fails without value detail",()=>assert.throws(()=>decodeCopyField(raw),SourceArchiveError));
}
for(const [value,expected] of [[AT,"2026-10-28T01:02:03.123456Z"],["2026-10-28 01:02:03.000001+09:00","2026-10-27T16:02:03.000001Z"],["2026-10-28T01:02:03-04","2026-10-28T05:02:03Z"]]){
 test("timestamp preserves microseconds and UTC instant",()=>assert.equal(normalizeArchiveTimestamp(value),expected));
}
for(const value of ["2026-02-30 01:02:03+00","2026-10-28 24:00:00+00","2026-10-28 01:02:03","2026-10-28 01:02:03.1234567+00",PRIVATE]){
 test("invalid timestamp fails closed",()=>assert.throws(()=>normalizeArchiveTimestamp(value),SourceArchiveError));
}
for(const sql of ["DROP TABLE auth.users;", "SELECT "+PRIVATE+";", "\\! "+PRIVATE, "SET search_path = 'evil';", "INSERT INTO auth.users VALUES ('"+PRIVATE+"');", 'COPY "public"."profiles" ("owner_id") FROM PROGRAM \'cat secret\';']){
 test("non-dump SQL or meta command is refused",()=>rejects(fixture()+sql+"\n"));
}
for(const [name,mutate] of [
 ["unknown public table",s=>s+copy("public","evil",["id"])],
 ["duplicate copy",s=>s+copy("public","profiles",COLUMNS.profiles)],
 ["unknown schema",s=>s+copy("evil","profiles",COLUMNS.profiles)],
 ["missing public table",s=>s.replace(copy("public","profiles",COLUMNS.profiles),"")],
 ["missing auth mfa",s=>s.replace(copy("auth","mfa_factors",["id","user_id","factor_type","status"]),"")],
 ["extra column",s=>s.replace(copy("public","profiles",COLUMNS.profiles),copy("public","profiles",[...COLUMNS.profiles,"secret"]))],
 ["missing column",s=>s.replace(copy("public","profiles",COLUMNS.profiles),copy("public","profiles",COLUMNS.profiles.slice(1)))],
 ["duplicate column",s=>s.replace(copy("public","profiles",COLUMNS.profiles),copy("public","profiles",[...COLUMNS.profiles.slice(1),"display_name"]))],
 ["missing copy end",s=>s.replace(copy("auth","sessions",["id"]),`COPY "auth"."sessions" ("id") FROM stdin;\n${PRIVATE}\n`)],
 ["wrong field count",s=>s.replace(copy("auth","sessions",["id"]),`COPY "auth"."sessions" ("id") FROM stdin;\n${PRIVATE}\textra\n\\.\n`)],
 ["escape out of copy",s=>s.replace(copy("auth","sessions",["id"]),`COPY "auth"."sessions" ("id") FROM stdin;\n\\.\nDROP TABLE ${PRIVATE};\n`)],
 ["wrong bool",s=>s.replace("t\tfrozen\tgcs","yes\tfrozen\tgcs")],
 ["wrong state",s=>s.replace("t\tfrozen\tgcs","t\tunknown\tgcs")],
 ["bad auth JSON",s=>s.replace(escape(user.raw_app_meta_data),"{"+PRIVATE)],
 ])test(`archive refuses ${name}`,()=>rejects(mutate(fixture())));
test("invalid UTF8, NUL, missing bytes and input overflow are rejected",()=>{
 for(const input of [Buffer.from([0xff]),Buffer.concat([Buffer.from(fixture()),Buffer.from([0])]),Buffer.alloc(0),Buffer.alloc(64*1024*1024+1)])rejects(input);
});
test("discarded rows still count against the 50000 row bound",()=>{
 rejects(fixture().replace(copy("auth","sessions",["id"]),`COPY "auth"."sessions" ("id") FROM stdin;\n${"x\n".repeat(50000)}\\.\n`));
});

test("the single ignored auth refresh-token sequence is inert, bounded and requires its COPY",()=>{
 const sequence='SELECT pg_catalog.setval(\'"auth"."refresh_tokens_id_seq"\', 9223372036854775807, true);\n';
 assert.equal(parse(fixture({extra:sequence})).users.length,1);
 rejects(sequence+fixture());
 for(const extra of [sequence+sequence,sequence.replace("refresh_tokens_id_seq","users_id_seq"),
  sequence.replace("9223372036854775807","9223372036854775808"),sequence.replace("9223372036854775807","(SELECT 1)")])rejects(fixture({extra}));
});
test("JSON numeric precision is preserved or explicitly refused",()=>{
 const base=fixture();
 for(const value of ['{"n":9007199254740993}','{"n":0.1234567890123456789}','{"n":1e999}','{"n":1e-999}']){
  rejects(base.replace(escape(user.raw_user_meta_data),escape(value)));
 }
 const accepted=parse(base.replace(escape(user.raw_user_meta_data),escape('{"n":1.0000000000000000000,"small":1e-6}')));
 assert.deepEqual(accepted.users[0].raw_user_meta_data,{n:1,small:1e-6});
});
test("PG17 prologue settings are recognized only with their fixed dump values",()=>{
 const lines=["SET lock_timeout = 0;","SET idle_in_transaction_session_timeout = 0;","SET transaction_timeout = 0;",
  "SET check_function_bodies = false;","SET xmloption = content;","SET client_min_messages = warning;","SET row_security = off;"];
 assert.equal(parse(lines.join("\n")+"\n"+fixture()).users.length,1);
 rejects("SET transaction_timeout = '"+PRIVATE+"';\n"+fixture());
});
