#!/usr/bin/env node
// Run after `supabase start`: fixed local Docker socket/container, read-only SQL.
// No Supabase API, credentials, DB mutation, user-selected SQL or remote host.
import { execFile } from "node:child_process";
import { INVENTORY_SQL } from "../../scripts/gcp/backup-supabase-storage.mjs";
import { json, validateSnapshot, requireValue, MAX_JSON_BYTES } from "../../scripts/gcp/storage-backup-format.mjs";

try {
  requireValue(process.argv.length === 2);
  const output = await new Promise((done, reject) => {
    const child = execFile("docker", [
      "--host", "unix:///var/run/docker.sock", "exec", "-i", "supabase_db_mfmf",
      "psql", "--username", "postgres", "--dbname", "postgres", "--no-psqlrc",
      "--set", "ON_ERROR_STOP=1", "--tuples-only", "--no-align", "--quiet",
    ], { env: { PATH: process.env.PATH }, timeout: 60_000, maxBuffer: MAX_JSON_BYTES, encoding: "buffer" },
    (error, stdout) => error ? reject(new Error("Local SQL failed")) : done(stdout));
    child.stdin.on("error", () => reject(new Error("Local SQL input failed")));
    child.stdin.end(`BEGIN TRANSACTION READ ONLY;\n${INVENTORY_SQL};\nROLLBACK;\n`);
  });
  validateSnapshot(json(output));
  process.stdout.write("Local Storage inventory SQL passed in a read-only transaction.\n");
} catch {
  process.stderr.write("Local Storage inventory SQL failed; details withheld.\n");
  process.exitCode = 1;
}
