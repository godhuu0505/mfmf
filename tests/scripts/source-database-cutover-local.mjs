#!/usr/bin/env node
// Synthetic-only PostgreSQL fixture. No supplied connection, existing container,
// host port, environment file, production archive or remote API is accepted.
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { SOURCE_TABLES, SOURCE_AUTH_TABLES, FREEZE_SOURCE_SQL, UNFREEZE_SOURCE_SQL, INSPECT_CUTOVER_STATE_SQL,
  INSPECT_SOURCE_CAPABILITIES_SQL, parseSourceCapabilities, parseCutoverProgress } from "../../scripts/gcp/source-database-cutover.mjs";
import { PROBE_SQL, processSqlState } from "../../scripts/gcp/backup-database-auth.mjs";
const IMAGE = "mfmf-gcp-postgres-test:17";
const NAME = `mfmf-cutover-proof-${randomUUID().slice(0, 12)}`;
const RUNTIME_ROLES = ["supabase_auth_admin", "authenticator", "anon", "authenticated", "service_role"];
const docker = (args, input) => execFileSync("docker", args, { input, encoding: "utf8", timeout: 120_000,
  maxBuffer: 4 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
const sql = (text, user = "postgres") => docker(["exec", "-i", NAME, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=sqlstate", "-U", user, "-d", "postgres"], text).trim();
const fixture = (text) => sql(text, "fixture_admin");
// Match the production --command path, including multiple progress SELECTs.
const cutover = (text) => parseCutoverProgress(docker(["exec", NAME, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1",
  "-v", "VERBOSITY=sqlstate", "-U", "postgres", "-d", "postgres", "--command", text]).trim()).result;
let created = false; let stage = "startup"; let checks = 0;
const check = (condition) => { assert.ok(condition); checks++; };
const denied = (text, user = "authenticator", code) => {
  let error; try { sql(text, user); } catch (caught) { error = caught; }
  check(Boolean(error?.status));
  if (code) check(new RegExp(`ERROR: +${code}(?:\\s|$)`).test(String(error.stderr)));
};
function rejectedFreeze(expectedStage) {
  let error;
  try { cutover(FREEZE_SOURCE_SQL); } catch (caught) { error = caught; }
  check(Boolean(error?.status));
  check(parseCutoverProgress(String(error.stdout)).substage === expectedStage);
  check(processSqlState(String(error.stderr)) === "55000");
}
async function staleWrite(table, user) {
  const child = spawn("docker", ["exec", "-i", NAME, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", user, "-d", "postgres"],
    { stdio: ["pipe", "pipe", "ignore"] });
  const finished = new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
  const ready = new Promise((resolve, reject) => { child.stdout.once("data", resolve); child.once("error", reject); });
  // Use another table to establish the old snapshot without retaining a lock on
  // the mutation target that would prevent freeze from draining it.
  child.stdin.end(`BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT 1 FROM pg_catalog.pg_class LIMIT 1; SELECT pg_sleep(2); UPDATE ${table} SET value='stale'; COMMIT;`);
  await ready;
  check(cutover(FREEZE_SOURCE_SQL) === "t|26|20|6");
  check(await finished !== 0);
  check(sql(`SELECT value<>'stale' FROM ${table}`) === "t");
}
try {
  check(process.argv.length === 2);
  docker(["run", "--detach", "--rm", "--name", NAME, "--network", "none", "--tmpfs", "/var/lib/postgresql/data:rw",
    "-e", "POSTGRES_HOST_AUTH_METHOD=trust", IMAGE]); created = true;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { docker(["exec", NAME, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]); break; }
    catch { if (attempt === 79) throw new Error(); await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  stage = "managed role fixture";
  sql("CREATE ROLE fixture_admin LOGIN SUPERUSER");
  // The bootstrap role OID 10 is special in PostgreSQL. Give the managed postgres
  // an ordinary OID, not a superficially demoted bootstrap superuser.
  fixture(`ALTER ROLE postgres RENAME TO fixture_bootstrap;
    CREATE ROLE postgres LOGIN INHERIT NOSUPERUSER BYPASSRLS CREATEROLE CREATEDB NOREPLICATION;
    ALTER DATABASE postgres OWNER TO postgres;
    CREATE ROLE supabase_admin LOGIN NOSUPERUSER BYPASSRLS;
    CREATE ROLE supabase_auth_admin LOGIN NOINHERIT NOSUPERUSER BYPASSRLS CREATEROLE;
    CREATE ROLE authenticator LOGIN NOINHERIT; CREATE ROLE anon LOGIN; CREATE ROLE authenticated LOGIN; CREATE ROLE service_role LOGIN BYPASSRLS;
    CREATE SCHEMA auth AUTHORIZATION supabase_auth_admin;
    GRANT USAGE ON SCHEMA auth TO postgres;
    ${SOURCE_AUTH_TABLES.map((name) => `CREATE TABLE ${name}(id integer PRIMARY KEY, value text);
      ALTER TABLE ${name} OWNER TO supabase_auth_admin; INSERT INTO ${name} VALUES(1,'synthetic');`).join("\n")}
    GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER ON ALL TABLES IN SCHEMA auth TO postgres;
    GRANT USAGE ON SCHEMA public,auth TO authenticator,anon,authenticated,service_role,supabase_admin;
    GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE ON ALL TABLES IN SCHEMA auth TO authenticator,anon,authenticated,service_role,supabase_admin;`);
  sql(`${SOURCE_TABLES.map((name) => `CREATE TABLE public.${name}(id integer PRIMARY KEY, value text);
      INSERT INTO public.${name} VALUES(1,'synthetic');`).join("\n")}
    GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE ON ALL TABLES IN SCHEMA public TO authenticator,supabase_auth_admin,anon,authenticated,service_role,supabase_admin;
    CREATE FUNCTION public.synthetic_definer_write() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
      UPDATE public.daycare_records SET value='definer' WHERE id=1 $$;
    GRANT EXECUTE ON FUNCTION public.synthetic_definer_write() TO authenticator;`);
  check(sql("SELECT oid<>10 AND NOT rolsuper AND rolbypassrls FROM pg_roles WHERE rolname=current_user") === "t");
  check(sql("SELECT count(*) FROM public.daycare_records", "authenticator") === "1");
  check(sql("SHOW default_transaction_read_only") === "off");
  check(/^17[0-9]{4}\|t\|t\|t\|t\|t$/.test(sql(PROBE_SQL)));
  stage = "catalog capabilities";
  const capabilities = parseSourceCapabilities(sql(INSPECT_SOURCE_CAPABILITIES_SQL));
  check(!capabilities.superuser && capabilities.transactionReadOnly && capabilities.publicTables.owner === 20);
  check(Object.values(capabilities.auth).every((table) => table.present && !table.owner && table.trigger && table.lock));
  check(Object.values(capabilities.replicationRoles).every((role) => role.present && !role.canSetReplicationRole));
  denied("ALTER TABLE auth.users ENABLE ALWAYS TRIGGER imaginary", "postgres");
  for (const role of RUNTIME_ROLES) {
    denied("SET session_replication_role=replica", role, "42501");
    denied("SELECT set_config('session_replication_role','replica',false)", role, "42501");
  }
  sql("SELECT public.synthetic_definer_write()", "authenticator"); checks++;
  stage = "table drift";
  sql("CREATE TABLE public.unreviewed(id integer)");
  rejectedFreeze("identity");
  check(sql("SELECT to_regnamespace('mfmf_cutover') IS NULL") === "t"); sql("DROP TABLE public.unreviewed");
  stage = "unsafe reachable roles";
  for (const role of ["fixture_setter", "fixture_super"]) {
    fixture(`CREATE ROLE ${role} NOLOGIN ${role === "fixture_super" ? "SUPERUSER" : "NOSUPERUSER"};
      ${role === "fixture_setter" ? "GRANT SET ON PARAMETER session_replication_role TO fixture_setter;" : ""}
      GRANT ${role} TO authenticator WITH INHERIT FALSE, SET FALSE;`);
    rejectedFreeze("safety");
    check(sql("SELECT to_regnamespace('mfmf_cutover') IS NULL") === "t");
    fixture(`REVOKE ${role} FROM authenticator; ${role === "fixture_setter" ? "REVOKE SET ON PARAMETER session_replication_role FROM fixture_setter;" : ""} DROP ROLE ${role};`);
  }
  stage = "unsafe replication defaults";
  for (const [change, undo] of [
    ["ALTER ROLE supabase_auth_admin SET session_replication_role=replica", "ALTER ROLE supabase_auth_admin RESET session_replication_role"],
    ["ALTER ROLE authenticator IN DATABASE postgres SET session_replication_role=replica", "ALTER ROLE authenticator IN DATABASE postgres RESET session_replication_role"],
    ["ALTER DATABASE postgres SET session_replication_role=replica", "ALTER DATABASE postgres RESET session_replication_role"],
  ]) {
    fixture(change); rejectedFreeze("safety");
    check(sql("SELECT to_regnamespace('mfmf_cutover') IS NULL") === "t"); fixture(undo);
  }
  stage = "Auth owner drift";
  fixture("ALTER TABLE auth.users OWNER TO fixture_admin"); rejectedFreeze("safety");
  fixture("ALTER TABLE auth.users OWNER TO supabase_auth_admin");
  // Ownership changes can replace ACL owner entries; explicitly restore only the
  // synthetic pre-existing grant, never add grants in the production SQL.
  fixture("GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER ON auth.users TO postgres");
  stage = "freeze";
  check(cutover(FREEZE_SOURCE_SQL) === "t|26|20|6");
  check(parseCutoverProgress(sql("SET default_transaction_read_only=on;\n" + FREEZE_SOURCE_SQL)).result === "t|26|20|6");
  check(cutover(FREEZE_SOURCE_SQL) === "t|26|20|6");
  for (const name of SOURCE_TABLES) {
    denied(`INSERT INTO public.${name} VALUES(2,'synthetic')`, "authenticator", "55000");
    denied(`UPDATE public.${name} SET value='changed' WHERE id=1`, "authenticator", "55000");
    denied(`DELETE FROM public.${name} WHERE id=1`, "authenticator", "55000");
    denied(`TRUNCATE public.${name}`, "authenticator", "55000");
  }
  stage = "Auth and security definer writes";
  for (const name of SOURCE_AUTH_TABLES) {
    denied(`INSERT INTO ${name} VALUES(2,'synthetic')`, "supabase_auth_admin", "55000");
    denied(`UPDATE ${name} SET value='changed' WHERE id=1`, "supabase_auth_admin", "55000");
    denied(`DELETE FROM ${name} WHERE id=1`, "supabase_auth_admin", "55000");
    denied(`TRUNCATE ${name}`, "supabase_auth_admin", "55000");
  }
  denied("SELECT public.synthetic_definer_write()", "authenticator", "55000");
  denied("UPDATE mfmf_cutover.state SET frozen=false", "authenticator");
  check(sql("SELECT count(*) FROM auth.users", "supabase_auth_admin") === "1");
  sql("UPDATE public.daycare_records SET value='operator' WHERE id=1", "supabase_admin"); checks++;
  stage = "post-freeze privilege drift";
  fixture("GRANT SET ON PARAMETER session_replication_role TO anon");
  denied(INSPECT_CUTOVER_STATE_SQL, "postgres"); denied(UNFREEZE_SOURCE_SQL, "postgres");
  check(sql("SELECT frozen FROM mfmf_cutover.state") === "t");
  fixture("REVOKE SET ON PARAMETER session_replication_role FROM anon");
  fixture("ALTER ROLE authenticated SET session_replication_role=replica");
  denied(INSPECT_CUTOVER_STATE_SQL, "postgres"); denied(UNFREEZE_SOURCE_SQL, "postgres");
  fixture("ALTER ROLE authenticated RESET session_replication_role");
  stage = "operator archive";
  const archive = execFileSync("docker", ["exec", NAME, "pg_dump", "-U", "postgres", "-d", "postgres", "-Fc",
    "--schema=public", "--schema=auth", "--schema=mfmf_cutover", "--strict-names"], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  check(archive.subarray(0, 5).equals(Buffer.from("PGDMP")));
  const list = docker(["exec", "-i", NAME, "pg_restore", "--list"], archive);
  check(list.includes("mfmf_cutover state") && list.includes("auth users") && list.includes("public daycare_records"));
  stage = "trigger shape and modes";
  sql("ALTER TABLE public.tags DISABLE TRIGGER mfmf_cutover_write_guard");
  denied(INSPECT_CUTOVER_STATE_SQL, "postgres"); denied(UNFREEZE_SOURCE_SQL, "postgres");
  check(sql("SELECT frozen FROM mfmf_cutover.state") === "t");
  sql("ALTER TABLE public.tags ENABLE ALWAYS TRIGGER mfmf_cutover_write_guard");
  check(cutover(UNFREEZE_SOURCE_SQL) === "f|26|20|6");
  for (const mode of ["DISABLE", "ENABLE REPLICA"]) {
    fixture(`ALTER TABLE auth.users ${mode} TRIGGER mfmf_cutover_write_guard`);
    rejectedFreeze("safety");
    check(sql("SELECT frozen FROM mfmf_cutover.state") === "f");
    denied(INSPECT_CUTOVER_STATE_SQL, "postgres");
    fixture("ALTER TABLE auth.users ENABLE TRIGGER mfmf_cutover_write_guard");
  }
  for (const definition of [
    "BEFORE INSERT OR UPDATE OR DELETE ON auth.users FOR EACH STATEMENT",
    "BEFORE INSERT OR UPDATE OR DELETE ON auth.users FOR EACH ROW",
    "BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON auth.users FOR EACH STATEMENT WHEN (false)",
    "BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON auth.users FOR EACH STATEMENT",
  ]) {
    fixture(`CREATE OR REPLACE TRIGGER mfmf_cutover_write_guard ${definition} EXECUTE FUNCTION mfmf_cutover.guard_source_write(${definition.endsWith("STATEMENT") && definition.includes("TRUNCATE") ? "'unexpected'" : ""})`);
    denied(INSPECT_CUTOVER_STATE_SQL, "postgres"); denied(UNFREEZE_SOURCE_SQL, "postgres");
    check(sql("SELECT frozen FROM mfmf_cutover.state") === "f");
  }
  check(cutover(FREEZE_SOURCE_SQL) === "t|26|20|6");
  check(cutover(UNFREEZE_SOURCE_SQL) === "f|26|20|6");
  check(sql(INSPECT_CUTOVER_STATE_SQL) === "f|26|20|6");
  sql("SELECT public.synthetic_definer_write()", "authenticator"); checks++;
  for (const name of SOURCE_AUTH_TABLES) { sql(`UPDATE ${name} SET value='after'`, "supabase_auth_admin"); checks++; }
  stage = "old transaction public";
  await staleWrite("public.daycare_records", "authenticator");
  check(cutover(UNFREEZE_SOURCE_SQL) === "f|26|20|6");
  stage = "old transaction Auth";
  await staleWrite("auth.users", "supabase_auth_admin");
  console.log(JSON.stringify({ syntheticChecks: checks, managedNonOwner: true, publicAlways: 20, authOrigin: 6,
    allTableWritesBlocked: true, authAdminBlocked: true, runtimeReplicationDenied: true, reachablePrivilegeRejected: true,
    securityDefinerBlocked: true, oldTransactionBlocked: true, operatorArchiveVerified: true }));
} catch {
  console.error(`Source cutover local proof failed at ${stage}; input and database output withheld.`); process.exitCode = 1;
} finally {
  if (created) { try { docker(["rm", "--force", NAME]); } catch { process.exitCode = 1; } }
}
