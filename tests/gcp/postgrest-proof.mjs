#!/usr/bin/env node
// No database URI, .env, production archive, host port, or existing container is
// accepted. This fixture owns exactly one random network-none/tmpfs container.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import webpack from "webpack";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const IMAGE = "mfmf-postgrest-proof:16.5";
const NAME = `mfmf-postgrest-proof-${randomUUID().slice(0, 12)}`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let created = false;
let stage = "image build";
const docker = (args, input) => execFileSync("docker", args, { cwd: ROOT, input, encoding: "utf8", timeout: 600_000, maxBuffer: 20 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
const remove = () => { if (created) { try { docker(["rm", "--force", NAME]); } catch { /* only the owned fixture */ } created = false; } };
process.once("SIGINT", () => { remove(); process.exit(130); });
process.once("SIGTERM", () => { remove(); process.exit(143); });

async function main() {
  if (process.argv.slice(2).some((arg) => arg !== "--skip-build")) throw new Error("Only --skip-build is supported.");
  if (!process.argv.includes("--skip-build")) {
    docker(["build", "-f", "tests/gcp/postgrest-proof.Dockerfile", "-t", IMAGE, "tests/gcp"]);
  }
  const temporary = await mkdtemp(path.join(tmpdir(), "mfmf-postgrest-proof-"));
  try {
    stage = "source bundle";
    // The real source is bundled without behavior changes. Only server-only's
    // RSC import marker is removed because this harness is a standalone Node CLI.
    const loader = path.join(temporary, "typescript-loader.cjs");
    const empty = path.join(temporary, "server-only.cjs");
    await writeFile(empty, "module.exports = {};\n");
    await writeFile(loader, `const ts = require(${JSON.stringify(path.join(ROOT, "node_modules/typescript"))}); module.exports = function(source) { return ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText; };\n`);
    // Keep this dependency check explicit for environments with a partial npm install.
    if (!ts.transpileModule) throw new Error("TypeScript is required.");
    const compiler = webpack({ mode: "none", target: "node22", devtool: false,
      entry: path.join(ROOT, "tests/gcp/postgrest-contract.mjs"), output: { path: temporary, filename: "contract.cjs" },
      resolve: { extensions: [".ts", ".mjs", ".js", ".json"], alias: { "server-only": empty, "@": path.join(ROOT, "src") } },
      module: { rules: [{ test: /\.ts$/, exclude: /node_modules/, use: loader }] },
    });
    await new Promise((resolve, reject) => compiler.run((error, stats) => {
      compiler.close(() => {});
      if (error || stats.hasErrors()) reject(new Error("Synthetic API fixture bundle failed.")); else resolve();
    }));
    stage = "container startup";
    docker(["run", "--detach", "--rm", "--name", NAME, "--network", "none", "--tmpfs", "/var/lib/postgresql/data:rw",
      "-e", "POSTGRES_HOST_AUTH_METHOD=trust", IMAGE]); created = true;
    for (let attempt = 0; attempt < 80; attempt++) {
      // The entrypoint's temporary init server accepts Unix sockets but no TCP.
      // Wait for the final server so init's shutdown cannot race the first SQL.
      try { docker(["exec", NAME, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]); break; }
      catch { if (attempt === 79) throw new Error("Synthetic database did not become ready."); await delay(250); }
    }
    stage = "binary version";
    const version = docker(["exec", NAME, "postgrest", "--version"]);
    if (!/^PostgREST 16\.5\b/m.test(version)) throw new Error("Unexpected PostgREST version.");
    const sql = (source, user = "postgres", database = "mfmf") => docker(["exec", "-i", NAME, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", user, "-d", database], source);
    stage = "database baseline";
    sql("CREATE DATABASE mfmf;", "postgres", "postgres");
    sql(await readFile(path.join(ROOT, "db/gcp/000_roles.sql"), "utf8"));
    const parts = await Promise.all(["010_identity.sql", "020_public.sql", "030_permissions.sql"].map((name) => readFile(path.join(ROOT, "db/gcp", name), "utf8")));
    sql(`BEGIN; SET ROLE mfmf_owner;\n${parts.join("\n")}\nCOMMIT;`, "mfmf_migrator");
    stage = "synthetic seed";
    sql(`BEGIN; SET ROLE mfmf_owner;
INSERT INTO auth.users(id,provider_subject,email,email_verified) VALUES
 ('91000000-0000-4000-8000-000000000001','postgrest-user-a','a@example.test',true),
 ('91000000-0000-4000-8000-000000000002','postgrest-user-b','b@example.test',true);
INSERT INTO public.households(id,name) VALUES
 ('92000000-0000-4000-8000-000000000001','synthetic A'),('92000000-0000-4000-8000-000000000002','synthetic B');
INSERT INTO public.household_members(household_id,user_id,role) VALUES
 ('92000000-0000-4000-8000-000000000001','91000000-0000-4000-8000-000000000001','owner'),
 ('92000000-0000-4000-8000-000000000002','91000000-0000-4000-8000-000000000002','owner');
INSERT INTO public.daycare_records(id,owner_id,household_id,body) VALUES
 ('93000000-0000-4000-8000-000000000001','91000000-0000-4000-8000-000000000001','92000000-0000-4000-8000-000000000001','synthetic A'),
 ('93000000-0000-4000-8000-000000000002','91000000-0000-4000-8000-000000000002','92000000-0000-4000-8000-000000000002','synthetic B');
CREATE FUNCTION public.proof_claims() RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER AS $$
 SELECT jsonb_build_object('uid',auth.uid(),'role',current_user,'pid',pg_backend_pid(),'timeout',current_setting('statement_timeout')) $$;
CREATE FUNCTION public.proof_slow() RETURNS void LANGUAGE sql SECURITY INVOKER AS $$ SELECT pg_sleep(9) $$;
GRANT EXECUTE ON FUNCTION public.proof_claims() TO authenticated,anon;
GRANT EXECUTE ON FUNCTION public.proof_slow() TO authenticated;
COMMIT;`, "mfmf_migrator");
    sql("SET ROLE media_operator; SELECT public.set_media_storage_mode('gcs');", "mfmf_operator");
    docker(["cp", path.join(temporary, "contract.cjs"), `${NAME}:/tmp/contract.cjs`]);
    stage = "API contract";
    let output;
    try { output = docker(["exec", NAME, "node", "/tmp/contract.cjs"]); }
    catch (error) {
      // Only our structured, fixed-label contract diagnostic may leave the CLI.
      try { const diagnostic = JSON.parse(error.stderr); if (typeof diagnostic.contractFailure === "string" && /^[A-Za-z0-9 /()-]{1,150}$/.test(diagnostic.contractFailure) && ["assertion", "execution"].includes(diagnostic.kind)) console.error(JSON.stringify(diagnostic)); } catch { /* fixed outer error below */ }
      throw new Error("Synthetic API contract failed.");
    }
    // Contract emits aggregate synthetic assertions only, no JWT or signing key.
    process.stdout.write(output);
  } finally { remove(); await rm(temporary, { recursive: true, force: true }); }
}
main().catch(() => { console.error(`Isolated PostgREST proof failed at ${stage}; no production resources were used.`); process.exitCode = 1; });
