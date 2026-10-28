#!/usr/bin/env node
// Synthetic-only PostgreSQL fixture. No supplied connection, existing container,
// host port, environment file, production archive or remote API is accepted.
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { SOURCE_TABLES, FREEZE_SOURCE_SQL, UNFREEZE_SOURCE_SQL, INSPECT_CUTOVER_STATE_SQL } from "../../scripts/gcp/source-database-cutover.mjs";
const IMAGE = "mfmf-gcp-postgres-test:17";
const NAME = `mfmf-cutover-proof-${randomUUID().slice(0, 12)}`;
const docker = (args, input) => execFileSync("docker", args, { input, encoding: "utf8", timeout: 120_000,
  maxBuffer: 4 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
const sql = (text, user = "postgres") => docker(["exec", "-i", NAME, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", user, "-d", "postgres"], text).trim();
let created = false; let stage = "startup"; let checks = 0;
const check = (condition) => { assert.ok(condition); checks++; };
const denied = (text, user = "authenticator") => { let rejected = false; try { sql(text, user); } catch { rejected = true; } check(rejected); };
try {
  check(process.argv.length === 2);
  docker(["run", "--detach", "--rm", "--name", NAME, "--network", "none", "--tmpfs", "/var/lib/postgresql/data:rw",
    "-e", "POSTGRES_HOST_AUTH_METHOD=trust", IMAGE]); created = true;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { docker(["exec", NAME, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]); break; }
    catch { if (attempt === 79) throw new Error(); await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  stage = "fixture";
  sql(`CREATE ROLE authenticator LOGIN; CREATE ROLE supabase_auth_admin LOGIN BYPASSRLS; CREATE ROLE supabase_admin LOGIN;
    CREATE SCHEMA auth; ${[...SOURCE_TABLES.map((name) => `public.${name}`), "auth.users", "auth.identities", "auth.mfa_factors"].map((name) =>
      `CREATE TABLE ${name}(id integer PRIMARY KEY, value text); INSERT INTO ${name} VALUES(1,'synthetic');`).join("\n")}
    GRANT USAGE ON SCHEMA public,auth TO authenticator,supabase_auth_admin,supabase_admin;
    GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE ON ALL TABLES IN SCHEMA public,auth TO authenticator,supabase_auth_admin,supabase_admin;
    CREATE FUNCTION public.synthetic_definer_write() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
      UPDATE public.daycare_records SET value='definer' WHERE id=1 $$;
    GRANT EXECUTE ON FUNCTION public.synthetic_definer_write() TO authenticator;`);
  check(sql("SELECT count(*) FROM public.daycare_records", "authenticator") === "1");
  sql("SELECT public.synthetic_definer_write()", "authenticator"); checks++;
  stage = "table drift";
  sql("CREATE TABLE public.unreviewed(id integer)"); denied(FREEZE_SOURCE_SQL, "postgres");
  check(sql("SELECT to_regnamespace('mfmf_cutover') IS NULL") === "t"); sql("DROP TABLE public.unreviewed");
  stage = "freeze";
  check(sql(FREEZE_SOURCE_SQL) === "t|23");
  check(sql(FREEZE_SOURCE_SQL) === "t|23"); // repeat freeze is explicit and idempotent
  for (const name of SOURCE_TABLES) {
    denied(`INSERT INTO public.${name} VALUES(2,'synthetic')`);
    denied(`UPDATE public.${name} SET value='changed' WHERE id=1`);
    denied(`DELETE FROM public.${name} WHERE id=1`);
    denied(`TRUNCATE public.${name}`);
  }
  stage = "auth and definer";
  for (const name of ["users", "identities", "mfa_factors"]) {
    denied(`INSERT INTO auth.${name} VALUES(2,'synthetic')`, "supabase_auth_admin");
    denied(`UPDATE auth.${name} SET value='changed' WHERE id=1`, "supabase_auth_admin");
    denied(`DELETE FROM auth.${name} WHERE id=1`, "supabase_auth_admin");
    denied(`TRUNCATE auth.${name}`, "supabase_auth_admin");
  }
  denied("SELECT public.synthetic_definer_write()", "authenticator");
  denied("UPDATE mfmf_cutover.state SET frozen=false", "authenticator");
  check(sql("SELECT count(*) FROM auth.users", "supabase_auth_admin") === "1");
  sql("UPDATE public.daycare_records SET value='operator' WHERE id=1", "supabase_admin"); checks++;
  stage = "operator dump";
  const archive = execFileSync("docker", ["exec", NAME, "pg_dump", "-U", "postgres", "-d", "postgres", "-Fc",
    "--schema=public", "--schema=auth", "--schema=mfmf_cutover", "--strict-names"], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  check(archive.subarray(0, 5).equals(Buffer.from("PGDMP")));
  const list = docker(["exec", "-i", NAME, "pg_restore", "--list"], archive);
  check(list.includes("mfmf_cutover state") && list.includes("auth users") && list.includes("public daycare_records"));
  stage = "unfreeze";
  sql("ALTER TABLE public.tags DISABLE TRIGGER mfmf_cutover_write_guard");
  denied(UNFREEZE_SOURCE_SQL, "postgres"); check(sql("SELECT frozen FROM mfmf_cutover.state") === "t");
  sql("ALTER TABLE public.tags ENABLE ALWAYS TRIGGER mfmf_cutover_write_guard");
  check(sql(UNFREEZE_SOURCE_SQL) === "f|23"); check(sql(INSPECT_CUTOVER_STATE_SQL) === "f|23");
  sql("SELECT public.synthetic_definer_write()", "authenticator"); checks++;
  sql("UPDATE auth.users SET value='after'", "supabase_auth_admin"); checks++;
  sql("UPDATE auth.mfa_factors SET value='after'", "supabase_auth_admin"); checks++;
  stage = "old transaction";
  const child = spawn("docker", ["exec", "-i", NAME, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "authenticator", "-d", "postgres"],
    { stdio: ["pipe", "pipe", "ignore"] });
  const finished = new Promise((resolve) => child.once("close", resolve));
  const ready = new Promise((resolve, reject) => { child.stdout.once("data", resolve); child.once("error", reject); });
  child.stdin.end("BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT count(*) FROM public.daycare_records; SELECT pg_sleep(2); UPDATE public.daycare_records SET value='stale'; COMMIT;");
  await ready;
  check(sql(FREEZE_SOURCE_SQL) === "t|23");
  check(await finished !== 0);
  check(sql("SELECT value<>'stale' FROM public.daycare_records") === "t");
  console.log(JSON.stringify({ syntheticChecks: checks, allTableWritesBlocked: true, authAdminBlocked: true,
    securityDefinerBlocked: true, oldTransactionBlocked: true, operatorArchiveVerified: true }));
} catch {
  console.error(`Source cutover local proof failed at ${stage}; input and database output withheld.`); process.exitCode = 1;
} finally {
  if (created) { try { docker(["rm", "--force", NAME]); } catch { process.exitCode = 1; } }
}
