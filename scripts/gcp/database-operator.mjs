#!/usr/bin/env node
// A fixed Cloud Run Job, never a SQL endpoint. No database/data value is logged.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

export const PROJECT = "mfmf-499612";
export const PROJECT_NUMBER = "92772745697";
export const JOB = "mfmf-db-operator";
export const ACCOUNT = `${JOB}@${PROJECT}.iam.gserviceaccount.com`;
export const INSTANCE = `${PROJECT}:asia-northeast1:mfmf-db`;
export const BUCKET = `${PROJECT}-db-migration`;
export const SOURCE = "aqvmuhqkaqedtxuqwhoq";
export const FORMAT = "mfmf-gcp-import-v1";
export const OPERATIONS = Object.freeze(["bootstrap", "inspect", "migrate", "restore-test", "upgrade", "activate", "freeze"]);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SOCKETS = "/tmp/mfmf-db-operator-sockets";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const GENERATION = /^[1-9][0-9]{0,19}$/;
const PASSWORD = /^[A-Za-z0-9_-]{32,128}$/;
const LIMIT = 64 * 1024 * 1024;
const BASE = Object.freeze({ PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" });
const STAGES = new Set(["context", "metadata", "source-contract", "connector", "credentials", "connect", "bootstrap", "bundle", "import", "inspect", "upgrade", "restore-test", "activate", "freeze", "cleanup"]);
export class OperatorError extends Error {
  constructor(stage) { super("Database operator failed; details withheld."); this.stage = STAGES.has(stage) ? stage : "context"; }
}
const requireValue = (ok, stage) => { if (!ok) throw new OperatorError(stage); };
const hash = (value) => createHash("sha256").update(value).digest("hex");
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
function keys(value, expected) {
  return object(value) && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}
export function diagnostic(error) { return { status: "failed", stage: error instanceof OperatorError ? error.stage : "context" }; }

// Every column must be present, including nulls. Missing columns cannot silently
// receive a new timestamp/default. The runner compares this list to the baseline.
export const COLUMNS = Object.freeze({
  media_assets: ["id","kind","entity_id","household_id","owner_id","created_by","incoming_key","final_key","byte_size","content_type","state","expires_at","generation","created_at","deleted_at","is_legacy","legacy_sha256","legacy_path","legacy_reference_id"],
  households: ["id","name","created_at","avatar_path","avatar_asset_id"],
  profiles: ["owner_id","display_name","default_author","created_at","updated_at","avatar_path","avatar_asset_id"],
  pets: ["id","owner_id","name","species","birthday","created_at","updated_at","household_id","avatar_path","avatar_asset_id"],
  household_members: ["household_id","user_id","role","created_at"],
  daycare_records: ["id","owner_id","record_date","body","created_at","updated_at","source","author","weight_kg","pet_id","household_id","guest_visible","status","start_time","end_time","overrides_rule"],
  record_photos: ["id","record_id","storage_path","created_at","household_id","media_asset_id"],
  tags: ["id","owner_id","name","created_at","household_id"],
  record_tags: ["record_id","tag_id","owner_id","created_at"],
  feedback: ["id","owner_id","kind","severity","frequency","title","body","when_happened","expected","actual","reporter","context","github_issue_url","github_issue_number","created_at","status","status_changed_at","household_id"],
  google_credentials: ["owner_id","refresh_token_enc","created_at","updated_at"],
  guest_grants: ["id","household_id","user_id","scope_pet_id","role","valid_from","valid_to","revoked_at","created_by","created_at"],
  household_invites: ["id","household_id","email","role","token","invited_by","created_at","expires_at","accepted_at","accepted_by","revoked_at","scope_pet_id","valid_from","valid_to"],
  schedule_rules: ["id","household_id","weekday","since","kind","start_time","end_time","created_by","created_at","updated_at"],
  schedule_rule_assignees: ["rule_id","role","user_id","created_at"],
  schedule_rule_skips: ["household_id","on_date","created_by","created_at"],
  record_assignees: ["record_id","role","user_id","created_at"],
  record_ranking_project_budget: ["singleton","usage_day","daily_count","lifetime_count"],
  record_ranking_user_budget: ["user_id","usage_day","daily_count","usage_minute","minute_count"],
});
const TABLES = Object.keys(COLUMNS);
const GUARDED_TABLES = ["auth.users",...TABLES.map(name=>`public.${name}`),"public.media_storage_state"];
const AUTH_COLUMNS = ["id", "provider_subject", "email", "email_verified", "created_at", "updated_at"];
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const timestamp = (value) => typeof value === "string" && TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));

export function parseImportIdentity(value) {
  requireValue(typeof value==="string" && Buffer.byteLength(value)<=512 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\uffff]/.test(value),"credentials");
  const lines=value.split(/\r?\n/);const keys=[];
  for(const line of lines) {
    if(line==="" || /^# [\x20-\x7e]*$/.test(line))continue;
    requireValue(/^AGE-SECRET-KEY-1[023456789ACDEFGHJKLMNPQRSTUVWXYZ]{58}$/.test(line),"credentials");
    keys.push(line);
  }
  requireValue(keys.length===1,"credentials");return keys[0];
}

export function validateContext(env) {
  requireValue(env.CLOUD_RUN_JOB === JOB && env.CLOUD_RUN_TASK_INDEX === "0" && env.CLOUD_RUN_TASK_COUNT === "1"
    && env.CLOUD_RUN_TASK_ATTEMPT === "0" && OPERATIONS.includes(env.MFMF_DB_OPERATION)
    && !env.GOOGLE_APPLICATION_CREDENTIALS && !env.PGHOST && !env.PGSERVICE && !env.PGOPTIONS, "context");
  let credentials;
  try { credentials = JSON.parse(env.MFMF_DB_OPERATOR_CREDENTIALS); } catch { throw new OperatorError("credentials"); }
  requireValue(keys(credentials, ["postgres", "migrator", "operator"])
    && Object.values(credentials).every((value) => typeof value === "string" && PASSWORD.test(value)), "credentials");
  if (env.MFMF_DB_OPERATION === "bootstrap") requireValue(PASSWORD.test(env.MFMF_DATABASE_PASSWORD ?? ""), "credentials");
  if (env.MFMF_DB_OPERATION === "upgrade") requireValue(/^[0-9a-f]{40}$/.test(env.MFMF_DB_DEPLOY_SHA ?? ""), "context");
  if (["activate","freeze"].includes(env.MFMF_DB_OPERATION)) requireValue(SHA.test(env.MFMF_DB_BUNDLE_SHA256 ?? ""),"context");
  if (["migrate", "restore-test"].includes(env.MFMF_DB_OPERATION)) {
    requireValue(SHA.test(env.MFMF_DB_BUNDLE_SHA256 ?? "") && GENERATION.test(env.MFMF_DB_BUNDLE_GENERATION ?? ""), "bundle");
    parseImportIdentity(env.MFMF_DB_IMPORT_IDENTITY);
  }
  return { operation: env.MFMF_DB_OPERATION, credentials };
}

export function validateBundle(value) {
  requireValue(keys(value, ["format", "source", "authMirror", "tables", "expected"])
    && value.format === FORMAT && keys(value.source, ["projectRef"]) && value.source.projectRef === SOURCE
    && Array.isArray(value.authMirror) && value.authMirror.length > 0 && value.authMirror.length <= 10000
    && keys(value.tables, TABLES) && keys(value.expected, ["counts"])
    && keys(value.expected.counts, ["auth_users", ...TABLES]), "bundle");
  const seen = new Set();
  for (const user of value.authMirror) {
    requireValue(keys(user, AUTH_COLUMNS) && UUID.test(user.id) && user.provider_subject === user.id
      && !seen.has(user.id) && typeof user.email_verified === "boolean"
      && timestamp(user.created_at) && timestamp(user.updated_at)
      && (user.email === null ? !user.email_verified : user.email_verified && typeof user.email === "string"
        && user.email.length > 0 && user.email.length <= 320 && !/[\u0000-\u001f\u007f]/.test(user.email)
        && user.email === user.email.trim().toLowerCase()), "bundle");
    seen.add(user.id);
  }
  let rows = value.authMirror.length;
  requireValue(value.expected.counts.auth_users === rows, "bundle");
  for (const name of TABLES) {
    const data = value.tables[name];
    requireValue(Array.isArray(data) && data.length <= 50000 && value.expected.counts[name] === data.length, "bundle");
    rows += data.length;
    requireValue(rows <= 50000, "bundle");
    for (const row of data) {
      requireValue(keys(row, COLUMNS[name]), "bundle");
      for (const [column, cell] of Object.entries(row)) {
        requireValue(cell === null || ["string", "boolean", "number"].includes(typeof cell)
          || (name === "feedback" && column === "context" && object(cell)), "bundle");
        if (typeof cell === "number") requireValue(Number.isFinite(cell), "bundle");
      }
    }
  }
  requireValue(value.tables.record_ranking_project_budget.length === 1
    && value.tables.record_ranking_project_budget[0].singleton === true
    && !value.tables.media_assets.some((asset) => asset.state === "reserved"), "bundle");
  return value;
}

export async function sourceContract(root = ROOT) {
  const raw = await readFile(join(root, "db/gcp/source-migrations.json"));
  const manifest = JSON.parse(raw.toString("utf8"));
  const names = (await readdir(join(root, "supabase/migrations"))).filter((name) => name.endsWith(".sql")).sort();
  requireValue(keys(manifest, names), "source-contract");
  for (const name of names) requireValue(SHA.test(manifest[name]) && hash(await readFile(join(root,"supabase/migrations",name))) === manifest[name], "source-contract");
  const parts = await Promise.all(["010_identity.sql","020_public.sql","030_permissions.sql"].map((name) => readFile(join(root,"db/gcp",name),"utf8")));
  return { manifestHash: hash(raw), baselineHash: hash(parts.join("\n")+"\n"+LEDGER_SQL), baseline: parts.join("\n") };
}

async function bounded(fetchImpl, url, options, limit = LIMIT) {
  const response = await fetchImpl(url, { ...options, redirect: "error", signal: AbortSignal.timeout(30000) });
  requireValue(response.ok && response.body, "bundle");
  const parts=[]; let bytes=0;
  for await (const chunk of response.body) { bytes+=chunk.length; requireValue(bytes<=limit,"bundle"); parts.push(Buffer.from(chunk)); }
  return Buffer.concat(parts);
}
async function metadata(fetchImpl) {
  const base="http://metadata.google.internal/computeMetadata/v1/";
  const get=(path)=>bounded(fetchImpl,base+path,{headers:{"Metadata-Flavor":"Google"}},16384);
  const project=(await get("project/project-id")).toString();
  const number=(await get("project/numeric-project-id")).toString();
  const email=(await get("instance/service-accounts/default/email")).toString();
  requireValue(project===PROJECT && number===PROJECT_NUMBER && email===ACCOUNT,"metadata");
  return async()=> {
    const result=JSON.parse((await get("instance/service-accounts/default/token")).toString());
    requireValue(typeof result.access_token==="string" && result.access_token.length>0 && result.access_token.length<=16384
      && !/[\r\n\0]/.test(result.access_token) && result.token_type==="Bearer","metadata");
    return result.access_token;
  };
}

function childCapture(spawnImpl, executable, args, input, env=BASE, limit=LIMIT, timeoutMs=60000) {
  return new Promise((resolveCapture,reject)=> {
    const child=spawnImpl(executable,args,{env,stdio:["pipe","pipe","ignore"],shell:false});
    const parts=[];let bytes=0,settled=false;
    const fail=()=> {if(settled)return;settled=true;clearTimeout(timer);child.kill("SIGKILL");reject(new OperatorError("bundle"));};
    const timer=setTimeout(fail,timeoutMs);
    child.on("error",fail);child.stdin.on("error",fail);child.stdout.on("error",fail);
    child.stdout.on("data",chunk=> {bytes+=chunk.length;if(bytes>limit)fail();else parts.push(chunk);});
    child.on("close",code=> {if(settled)return;if(code!==0){fail();return;}settled=true;clearTimeout(timer);resolveCapture(Buffer.concat(parts));});
    child.stdin.end(input);
  });
}
export async function loadBundle(env, token, fetchImpl, spawnImpl) {
  const sha=env.MFMF_DB_BUNDLE_SHA256, generation=env.MFMF_DB_BUNDLE_GENERATION;
  const name=`imports/${sha}.json.age`;
  const base=`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(name)}`;
  const headers={Authorization:`Bearer ${await token()}`};
  const info=JSON.parse((await bounded(fetchImpl,`${base}?generation=${generation}`,{headers},65536)).toString());
  requireValue(info.bucket===BUCKET && info.name===name && info.generation===generation
    && /^[1-9][0-9]*$/.test(info.size) && Number(info.size)<=LIMIT,"bundle");
  const bytes=await bounded(fetchImpl,`${base}?alt=media&generation=${generation}`,{headers});
  const header=Buffer.from("age-encryption.org/v1\n-");
  requireValue(bytes.length===Number(info.size) && bytes.subarray(0,header.length).equals(header),"bundle");
  const directory=await mkdtemp(join(tmpdir(),"mfmf-db-bundle-"));
  try {
    const path=join(directory,"bundle.age");
    await writeFile(path,bytes,{mode:0o600,flag:"wx"}); // Ciphertext only; the identity is stdin, plaintext stays memory.
    const plain=await childCapture(spawnImpl,"/usr/bin/age",["--decrypt","--identity","-",path],`${parseImportIdentity(env.MFMF_DB_IMPORT_IDENTITY)}\n`);
    requireValue(hash(plain)===sha,"bundle");
    return validateBundle(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(plain)));
  } finally {await rm(directory,{recursive:true,force:true});}
}

export const LEDGER_SQL = `CREATE SCHEMA migration_admin AUTHORIZATION mfmf_owner;
REVOKE ALL ON SCHEMA migration_admin FROM PUBLIC,anon,authenticated,identity_sync,media_operator;
CREATE TABLE migration_admin.history(name text PRIMARY KEY,sha256 text NOT NULL CHECK(sha256~'^[0-9a-f]{64}$'),applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE migration_admin.imports(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),sha256 text NOT NULL CHECK(sha256~'^[0-9a-f]{64}$'),counts jsonb NOT NULL,applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE migration_admin.write_state(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),frozen boolean NOT NULL);
INSERT INTO migration_admin.write_state(singleton,frozen) VALUES(true,true);
REVOKE ALL ON ALL TABLES IN SCHEMA migration_admin FROM PUBLIC,anon,authenticated,identity_sync,media_operator;
CREATE FUNCTION migration_admin.guard_database_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $guard$
DECLARE blocked boolean;
BEGIN
  IF session_user IN ('postgres','mfmf_migrator','mfmf_operator') THEN RETURN NULL; END IF;
  SELECT frozen INTO blocked FROM migration_admin.write_state WHERE singleton FOR SHARE;
  IF COALESCE(blocked,true) THEN
    RAISE EXCEPTION 'Database is frozen for migration' USING ERRCODE='55000';
  END IF;
  RETURN NULL;
END $guard$;
REVOKE ALL ON FUNCTION migration_admin.guard_database_write() FROM PUBLIC,anon,authenticated,identity_sync,media_operator;
${GUARDED_TABLES.map(name=>`CREATE TRIGGER mfmf_database_write_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON ${name}
  FOR EACH STATEMENT EXECUTE FUNCTION migration_admin.guard_database_write();
ALTER TABLE ${name} ENABLE ALWAYS TRIGGER mfmf_database_write_guard;`).join("\n")}`;
const LOCK="SELECT pg_advisory_xact_lock(1296451151,1)";
const IMPORT_LOCK=`LOCK TABLE auth.users,${TABLES.map(name=>`public.${name}`).join(",")},public.media_storage_state IN ACCESS EXCLUSIVE MODE`;

async function transaction(client,fn,stage="import") {
  await client.query("BEGIN; SET LOCAL ROLE mfmf_owner; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s';");
  try {await client.query(LOCK);const result=await fn();await client.query("COMMIT");return result;}
  catch(error) {await client.query("ROLLBACK").catch(()=>{});throw error instanceof OperatorError?error:new OperatorError(stage);}
}
async function baselineGate(client,contract) {
  const rows=(await client.query("SELECT name,sha256 FROM migration_admin.history WHERE name='baseline'")).rows;
  requireValue(rows.length===1 && rows[0].sha256===contract.baselineHash,"source-contract");
}
async function counts(client) {
  const result={auth_users:Number((await client.query("SELECT count(*)::int n FROM auth.users")).rows[0].n)};
  for(const name of TABLES)result[name]=Number((await client.query(`SELECT count(*)::int n FROM public.${name}`)).rows[0].n);
  return result;
}
export async function importBundle(client,bundle,sha,contract) {
  validateBundle(bundle);requireValue(SHA.test(sha),"bundle");
  return transaction(client,async()=> {
    await baselineGate(client,contract);await client.query(IMPORT_LOCK);
    const state=(await client.query("SELECT mode,read_backend FROM public.media_storage_state WHERE singleton")).rows;
    requireValue(state.length===1 && state[0].mode==="frozen" && state[0].read_backend==="gcs","import");
    requireValue((await writeGate(client)).frozen,"import");
    requireValue((await client.query("SELECT count(*)::int n FROM migration_admin.imports")).rows[0].n===0,"import");
    const empty=await counts(client);
    requireValue(Object.entries(empty).every(([name,count])=>count===(name==="record_ranking_project_budget"?1:0)),"import");
    const budget=(await client.query("SELECT daily_count,lifetime_count,usage_day::text FROM public.record_ranking_project_budget")).rows[0];
    requireValue(budget.daily_count===0 && budget.lifetime_count===0 && budget.usage_day==="1970-01-01","import");
    await client.query("DELETE FROM public.record_ranking_project_budget");
    for(const [name,columns,rows] of [["auth.users",AUTH_COLUMNS,bundle.authMirror],...TABLES.map(name=>[`public.${name}`,COLUMNS[name],bundle.tables[name]])]) {
      const sql=`INSERT INTO ${name} (${columns.join(",")}) VALUES (${columns.map((_,index)=>`$${index+1}`).join(",")})`;
      for(const row of rows)await client.query(sql,columns.map(column=>row[column]));
    }
    const actual=await counts(client);
    requireValue(Object.keys(actual).every(name=>actual[name]===bundle.expected.counts[name]),"import");
    await verifyMedia(client);
    await client.query("INSERT INTO migration_admin.imports(singleton,sha256,counts) VALUES(true,$1,$2)",[sha,actual]);
    return {counts:actual,mediaWrites:"frozen",readBackend:"gcs"};
  });
}

async function verifyMedia(client,allowPending=false) {
  const problems=(await client.query(`SELECT (
    (SELECT count(*) FROM public.record_photos p LEFT JOIN public.media_assets a ON a.id=p.media_asset_id
      JOIN public.daycare_records r ON r.id=p.record_id
      WHERE a.id IS NULL OR a.state<>'ready' OR a.kind<>'photo' OR a.entity_id<>p.record_id
       OR a.household_id<>p.household_id OR a.owner_id<>r.owner_id OR a.final_key<>p.storage_path
       OR (CASE WHEN a.is_legacy THEN a.legacy_reference_id ELSE a.id END)<>p.id)
    + (SELECT count(*) FROM (
       SELECT 'profile' kind,owner_id entity_id,NULL::uuid household_id,owner_id,avatar_path path,avatar_asset_id asset FROM public.profiles
       UNION ALL SELECT 'household',id,id,NULL::uuid,avatar_path,avatar_asset_id FROM public.households
       UNION ALL SELECT 'pet',id,household_id,owner_id,avatar_path,avatar_asset_id FROM public.pets
      ) p LEFT JOIN public.media_assets a ON a.id=p.asset WHERE
       (p.path IS NULL)<>(p.asset IS NULL) OR (p.path IS NOT NULL AND (a.id IS NULL OR a.state<>'ready'
       OR a.kind<>p.kind OR a.entity_id<>p.entity_id OR a.household_id IS DISTINCT FROM p.household_id
       OR a.owner_id IS DISTINCT FROM p.owner_id OR a.final_key<>p.path)))
    + (SELECT count(*) FROM public.media_assets a WHERE state='ready' AND NOT EXISTS (SELECT 1 FROM public.record_photos WHERE media_asset_id=a.id)
       AND NOT EXISTS (SELECT 1 FROM public.profiles WHERE avatar_asset_id=a.id)
       AND NOT EXISTS (SELECT 1 FROM public.households WHERE avatar_asset_id=a.id)
       AND NOT EXISTS (SELECT 1 FROM public.pets WHERE avatar_asset_id=a.id))
    + (SELECT count(*) FROM public.media_assets WHERE state='reserved' AND NOT $1::boolean)
    + (SELECT count(*) FROM auth.users WHERE provider_subject IS NULL)
  )::int n`,[allowPending])).rows[0].n;
  requireValue(problems===0,"import");
}

export async function upgrade(client,contract,root=ROOT,beforeMigrations) {
  let names=[];
  try {names=(await readdir(join(root,"db/gcp/migrations"))).sort();} catch(error){if(error.code!=="ENOENT")throw error;}
  requireValue(names.every(name=>/^\d{14}_[a-z0-9_]+\.sql$/.test(name)),"upgrade");
  const files=await Promise.all(names.map(async name=>({name,sql:await readFile(join(root,"db/gcp/migrations",name),"utf8")})));
  return transaction(client,async()=> {
    await baselineGate(client,contract);
    const applied=(await client.query("SELECT name,sha256 FROM migration_admin.history WHERE name<>'baseline' ORDER BY name")).rows;
    requireValue(applied.length<=files.length && applied.every((row,index)=>row.name===files[index].name && row.sha256===hash(files[index].sql)),"upgrade");
    if(files.length>applied.length) {
      requireValue(typeof beforeMigrations==="function","upgrade");
      await beforeMigrations(); // TTL-bound, verified backup before the first schema write.
    }
    for(const file of files.slice(applied.length)) {
      // Files are reviewed image contents, never SQL received in a bundle/request.
      await client.query(file.sql);
      await client.query("INSERT INTO migration_admin.history(name,sha256) VALUES($1,$2)",[file.name,hash(file.sql)]);
    }
    return {applied:files.length-applied.length,sourceManifestVerified:true};
  },"upgrade");
}

async function writeGate(client,lock=false) {
  const rows=(await client.query("SELECT frozen FROM migration_admin.write_state WHERE singleton"+(lock?" FOR UPDATE":""))).rows;
  requireValue(rows.length===1 && typeof rows[0].frozen==="boolean","inspect");
  const triggers=(await client.query(`SELECT count(*)::int n FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='A'
    AND tgname='mfmf_database_write_guard' AND tgfoid='migration_admin.guard_database_write()'::regprocedure
    AND tgtype=62 AND tgrelid IN (${GUARDED_TABLES.map(name=>`'${name}'::regclass`).join(",")})`)).rows[0].n;
  requireValue(triggers===GUARDED_TABLES.length,"inspect");
  return rows[0];
}

async function inspect(client,contract) {
  return transaction(client,async()=> {
    await baselineGate(client,contract);
    const role=(await client.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname='authenticator'")).rows;
    requireValue(role.length===1 && !role[0].rolsuper && !role[0].rolbypassrls,"inspect");
    const state=(await client.query("SELECT mode,read_backend FROM public.media_storage_state WHERE singleton")).rows;
    requireValue(state.length===1 && ["frozen","gcs"].includes(state[0].mode) && state[0].read_backend==="gcs","inspect");
    const writes=await writeGate(client);
    requireValue(writes.frozen===(state[0].mode==="frozen"),"inspect");
    const history=(await client.query("SELECT count(*)::int n FROM migration_admin.imports")).rows[0].n;
    if(history)await verifyMedia(client,true);
    return {counts:await counts(client),mediaWrites:state[0].mode,databaseWrites:writes.frozen?"frozen":"enabled",readBackend:"gcs",imported:history===1};
  },"inspect");
}

export async function setMediaMode(client,contract,sha,desired) {
  requireValue(SHA.test(sha) && ["gcs","frozen"].includes(desired),"context");
  return transaction(client,async()=> {
    await baselineGate(client,contract);
    // Match set_media_storage_mode lock ordering: drain row mutations before
    // locking the singleton, avoiding a state-row/parent-row lock inversion.
    await client.query(`LOCK TABLE ${GUARDED_TABLES.join(",")} IN SHARE ROW EXCLUSIVE MODE`);
    const imports=(await client.query("SELECT sha256 FROM migration_admin.imports WHERE singleton")).rows;
    requireValue(imports.length===1 && imports[0].sha256===sha,"inspect");
    const states=(await client.query("SELECT mode,read_backend FROM public.media_storage_state WHERE singleton FOR UPDATE")).rows;
    requireValue(states.length===1 && ["frozen","gcs"].includes(states[0].mode) && states[0].read_backend==="gcs","inspect");
    const writes=await writeGate(client,true);
    requireValue(writes.frozen===(states[0].mode==="frozen"),"inspect");
    await verifyMedia(client,desired==="frozen");
    const changed=states[0].mode!==desired;
    if(changed){
      await client.query("SET LOCAL ROLE media_operator");
      await client.query("SELECT public.set_media_storage_mode($1)",[desired]);
      await client.query("SET LOCAL ROLE mfmf_owner");
      await client.query("UPDATE migration_admin.write_state SET frozen=$1 WHERE singleton",[desired==="frozen"]);
    }
    return {mediaWrites:desired,databaseWrites:desired==="frozen"?"frozen":"enabled",readBackend:"gcs",changed,externalIdentityAndObjectChecks:"operator-required"};
  },"inspect");
}

export async function applyBaseline(admin,contract,root,credentials,runtimePassword) {
  await admin.query("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s';");
  try {
    await admin.query(LOCK);
    // SQLAdmin may have provisioned the fixed database already. Accept only a
    // pristine postgres-owned database, never reset existing objects or roles.
    const catalog=(await admin.query(`SELECT (
      current_database()='mfmf' AND current_user='postgres'
      AND EXISTS (SELECT 1 FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba
        WHERE d.datname=current_database() AND r.rolname='postgres' AND pg_encoding_to_char(d.encoding)='UTF8')
      AND EXISTS (SELECT 1 FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner
        WHERE n.nspname='public' AND r.rolname IN ('postgres','pg_database_owner'))
      AND NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname NOT IN ('public','information_schema') AND nspname !~ '^pg_')
      AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public')
      AND NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public')
      AND NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public')
      AND NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname<>'plpgsql')
      AND NOT EXISTS (SELECT 1 FROM pg_event_trigger)
      AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN
        ('mfmf_owner','anon','authenticated','identity_sync','media_operator','authenticator','mfmf_migrator','mfmf_operator'))
    ) AS pristine`)).rows;
    requireValue(catalog.length===1 && catalog[0].pristine===true,"bootstrap");
    await admin.query(await readFile(join(root,"db/gcp/000_roles.sql"),"utf8"));
    await admin.query("SET LOCAL ROLE mfmf_owner");
    await admin.query(contract.baseline);
    await admin.query(LEDGER_SQL);
    await admin.query("INSERT INTO migration_admin.history(name,sha256) VALUES('baseline',$1)",[contract.baselineHash]);
    await admin.query("RESET ROLE");
    // Values travel as parameters and transaction-local settings, never argv,
    // files or application logs. SQL identifiers are fixed, not input strings.
    for(const [role,password] of [["mfmf_migrator",credentials.migrator],["mfmf_operator",credentials.operator],["authenticator",runtimePassword]]) {
      await admin.query("SELECT set_config('mfmf.bootstrap_password',$1,true)",[password]);
      await admin.query(`DO $$ BEGIN EXECUTE format('ALTER ROLE ${role} PASSWORD %L',current_setting('mfmf.bootstrap_password')); END $$;`);
    }
    await admin.query("COMMIT");
  } catch {await admin.query("ROLLBACK").catch(()=>{});throw new OperatorError("bootstrap");}
}

async function restoredDatabase(admin,connect,contract,bundle,sha,root) {
  const database="mfmf_restore_probe";
  const proofRole="mfmf_restore_proof";
  let owned=false,ownedRole=false,client,proofClient;
  requireValue((await admin.query("SELECT count(*)::int n FROM pg_database WHERE datname=$1",[database])).rows[0].n===0,"restore-test");
  requireValue((await admin.query("SELECT count(*)::int n FROM pg_roles WHERE rolname=$1",[proofRole])).rows[0].n===0,"restore-test");
  try {
    await admin.query("CREATE DATABASE mfmf_restore_probe OWNER mfmf_owner");owned=true;
    const setup=await connect("postgres",database);
    try {
      await setup.query("CREATE SCHEMA extensions AUTHORIZATION mfmf_owner; CREATE EXTENSION pg_trgm WITH SCHEMA extensions; CREATE EXTENSION pgtap WITH SCHEMA extensions; GRANT USAGE ON SCHEMA extensions TO mfmf_owner,authenticated,anon,identity_sync;");
      await setup.query("ALTER SCHEMA public OWNER TO mfmf_owner; REVOKE ALL ON SCHEMA public FROM PUBLIC;");
      await setup.query("ALTER DATABASE mfmf_restore_probe SET search_path=public,extensions;");
    } finally {await setup.end();}
    client=await connect("mfmf_migrator",database);
    await client.query("BEGIN; SET LOCAL ROLE mfmf_owner;");
    try {
      await client.query(contract.baseline);await client.query(LEDGER_SQL);
      await client.query("INSERT INTO migration_admin.history(name,sha256) VALUES('baseline',$1)",[contract.baselineHash]);
      await client.query("UPDATE migration_admin.write_state SET frozen=false WHERE singleton");
      await client.query("COMMIT");
    }catch{await client.query("ROLLBACK").catch(()=>{});throw new OperatorError("restore-test");}
    await client.end();client=null; // Keep the connector's two-connection bound.
    const proofPassword=randomBytes(32).toString("base64url");
    await admin.query("BEGIN");
    try {
      await admin.query("CREATE ROLE mfmf_restore_proof LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; GRANT mfmf_owner,authenticated,anon,identity_sync,media_operator TO mfmf_restore_proof;");
      await admin.query("SELECT set_config('mfmf.proof_password',$1,true)",[proofPassword]);
      await admin.query("DO $$ BEGIN EXECUTE format('ALTER ROLE mfmf_restore_proof PASSWORD %L',current_setting('mfmf.proof_password')); END $$;");
      await admin.query("COMMIT");ownedRole=true;
    }catch{await admin.query("ROLLBACK").catch(()=>{});throw new OperatorError("restore-test");}
    const extensionGrant=await connect("postgres",database);
    try {await extensionGrant.query("GRANT USAGE ON SCHEMA extensions TO mfmf_restore_proof;");}
    finally {await extensionGrant.end();}
    proofClient=await connect(proofRole,database,proofPassword);
    await proofClient.query("SET ROLE media_operator; SELECT public.set_media_storage_mode('gcs'); RESET ROLE;");
    let assertions=0;
    for(const name of ["db_identity_security.sql","db_media_gcs.sql","db_ranking.sql"]) {
      const results=await proofClient.query(await readFile(join(root,"tests/gcp",name),"utf8"));
      const text=(Array.isArray(results)?results:[results]).flatMap(result=>result.rows??[])
        .flatMap(row=>Object.values(row)).filter(value=>typeof value==="string").join("\n");
      requireValue(!/^not ok /m.test(text),"restore-test");
      const passed=[...text.matchAll(/^ok \d+(?: |$)/gm)].length;
      const plan=[...text.matchAll(/^1\.\.(\d+)$/gm)];
      requireValue(plan.length===1 && passed===Number(plan[0][1]) && passed>0,"restore-test");
      assertions+=passed;
    }
    await proofClient.query("SET ROLE media_operator; SELECT public.set_media_storage_mode('frozen'); RESET ROLE;");
    await proofClient.end();proofClient=null;
    client=await connect("mfmf_migrator",database);
    await transaction(client,async()=>client.query("UPDATE migration_admin.write_state SET frozen=true WHERE singleton"));
    const restored=await importBundle(client,bundle,sha,contract);
    // Compare source-preserving JSON values, not only row counts. PostgreSQL
    // typed normalization is checked against the same input by IS NOT DISTINCT.
    await transaction(client,async()=> {
      for(const [name,columns,rows] of [["auth.users",AUTH_COLUMNS,bundle.authMirror],...TABLES.map(name=>[`public.${name}`,COLUMNS[name],bundle.tables[name]])]) {
        for(const row of rows) {
          const conditions=columns.map((column,index)=>`${column} IS NOT DISTINCT FROM $${index+1}`).join(" AND ");
          const found=(await client.query(`SELECT count(*)::int n FROM ${name} WHERE ${conditions}`,columns.map(column=>row[column]))).rows[0].n;
          requireValue(found===1,"restore-test");
        }
      }
    });
    await client.end();client=null;
    return {...restored,restore:"all-rows-compared",assertions,temporaryDatabaseRemoved:true};
  } finally {
    if(proofClient)await proofClient.end().catch(()=>{});
    if(client)await client.end().catch(()=>{});
    if(owned)await admin.query("DROP DATABASE mfmf_restore_probe");
    if(ownedRole)await admin.query("DROP ROLE mfmf_restore_proof");
  }
}

export async function runOperator({env=process.env,fetchImpl=fetch,spawnImpl=spawn,root=ROOT,
  connectImpl,metadataImpl=metadata,bundleImpl=loadBundle,startConnector=true}={}) {
  let stage="context",proxy,clients=[];
  try {
    const {operation,credentials}=validateContext(env);
    stage="source-contract";const contract=await sourceContract(root);
    stage="metadata";const token=await metadataImpl(fetchImpl);
    stage="connector";
    if(startConnector) {
      const {mkdir}=await import("node:fs/promises");await mkdir(SOCKETS,{recursive:true,mode:0o700});
      proxy=spawnImpl("/usr/local/bin/cloud-sql-proxy",["--private-ip",`--unix-socket=${SOCKETS}`,"--max-connections=2","--quiet",INSTANCE],{env:BASE,stdio:"ignore",shell:false});
      proxy.on("error",()=>{});
    }
    const PgClient=connectImpl ? null : (await import("pg")).Client;
    async function connect(user,database="mfmf",temporaryPassword) {
      const password=temporaryPassword??(user==="postgres"?credentials.postgres:user==="mfmf_migrator"?credentials.migrator:credentials.operator);
      const options={host:`${SOCKETS}/${INSTANCE}`,port:5432,user,database,password,ssl:false,
        connectionTimeoutMillis:5000,query_timeout:65000,application_name:JOB,statement_timeout:60000};
      const client=connectImpl?await connectImpl(options):new PgClient(options);
      client.on?.("error",()=>{}); // Never let a background pg error print its raw detail.
      if(!connectImpl)await client.connect();clients.push(client);return client;
    }
    stage="connect";
    let client;
    // Connector startup retries never repeat SQL, import, or schema mutations.
    for(let i=0;i<15;i++) {
      try {client=await connect(operation==="bootstrap"||operation==="restore-test"?"postgres":"mfmf_migrator",operation==="bootstrap"?"postgres":"mfmf");break;}
      catch {if(i===14)throw new OperatorError("connect");await new Promise(resolve=>setTimeout(resolve,1000));}
    }
    const identity=(await client.query("SELECT current_database() db,current_user AS usr,current_setting('server_version_num')::int version")).rows[0];
    requireValue(identity.db===(operation==="bootstrap"?"postgres":"mfmf") && identity.usr===(operation==="bootstrap"||operation==="restore-test"?"postgres":"mfmf_migrator") && Math.floor(identity.version/10000)===17,"connect");
    stage=operation;
    let result;
    if(operation==="bootstrap") {
      const databases=(await client.query("SELECT count(*)::int n FROM pg_database WHERE datname='mfmf'")).rows[0].n;
      requireValue(databases===0 || databases===1,"bootstrap");
      if(databases===0)await client.query("CREATE DATABASE mfmf");
      await client.end();clients=clients.filter(item=>item!==client);
      client=await connect("postgres");
      await applyBaseline(client,contract,root,credentials,env.MFMF_DATABASE_PASSWORD);
      result={baseline:"applied",mediaWrites:"frozen",readBackend:"gcs"};
    }else if(operation==="inspect")result=await inspect(client,contract);
    else if(operation==="activate"||operation==="freeze")result=await setMediaMode(client,contract,env.MFMF_DB_BUNDLE_SHA256,operation==="activate"?"gcs":"frozen");
    else if(operation==="upgrade") {
      result=await upgrade(client,contract,root,async()=> {
        const {ensurePreMigrationBackup}=await import("./database-prebackup.mjs");
        await ensurePreMigrationBackup({env,accessToken:await token(),fetchImpl,maxPolls:96});
      });
    }else {
      stage="bundle";const bundle=await bundleImpl(env,token,fetchImpl,spawnImpl);
      stage=operation;
      result=operation==="migrate"?await importBundle(client,bundle,env.MFMF_DB_BUNDLE_SHA256,contract)
        :await restoredDatabase(client,connect,contract,bundle,env.MFMF_DB_BUNDLE_SHA256,root);
    }
    return {status:"verified",operation,...result};
  }catch(error){if(error instanceof OperatorError)throw error;throw new OperatorError(stage);}
  finally {
    for(const client of clients)await client.end().catch(()=>{});
    if(proxy){proxy.kill("SIGTERM");const timer=setTimeout(()=>proxy.kill("SIGKILL"),3000);timer.unref();}
  }
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  process.stdout.on("error",()=>{process.exitCode=1;});
  process.stderr.on("error",()=>{process.exitCode=1;});
  const args=process.argv.slice(2);
  if(args.length===0 || (args.length===1 && args[0]==="--plan")) {
    process.stdout.write(JSON.stringify({mode:"plan",job:JOB,project:PROJECT,instance:INSTANCE,bucket:BUCKET,operations:OPERATIONS,network:false})+"\n");
  }else if(args.length===1 && args[0]==="--execute") {
    const timer=setTimeout(()=>process.exit(1),12*60*1000);timer.unref();
    runOperator().then(result=>process.stdout.write(JSON.stringify(result)+"\n"))
      .catch(error=>{process.stderr.write(JSON.stringify(diagnostic(error))+"\n");process.exitCode=1;});
  }else {process.stderr.write(JSON.stringify(diagnostic(null))+"\n");process.exitCode=1;}
}
