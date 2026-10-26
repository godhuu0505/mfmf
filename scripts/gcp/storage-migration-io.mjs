// Fixed operator contexts, encrypted private files and bounded Management API.
import { spawn } from "node:child_process";
import { open, mkdir, lstat, rename, rm } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { SOURCE_REF, requireValue, fail, json, MAX_JSON_BYTES } from "./storage-backup-format.mjs";
import { MIGRATION_PROJECT, MIGRATION_PROJECT_NUMBER, OPERATOR_SA, STORAGE_WIF, responseBytes } from "./storage-migration-gcs.mjs";

export function requireMigrationContext(env) {
  requireValue(env.GITHUB_ACTIONS === "true" && env.GITHUB_REPOSITORY === "godhuu0505/mfmf" && env.GITHUB_REF === "refs/heads/main" && ["workflow_dispatch", "schedule"].includes(env.GITHUB_EVENT_NAME));
  requireValue(env.GITHUB_WORKFLOW_REF === "godhuu0505/mfmf/.github/workflows/storage-migration.yml@refs/heads/main");
  requireValue(env.SUPABASE_PROJECT_ID === SOURCE_REF && env.GCP_PROJECT_ID === MIGRATION_PROJECT && env.GCP_PROJECT_NUMBER === MIGRATION_PROJECT_NUMBER);
  requireValue(env.GCP_STORAGE_WIF_PROVIDER === STORAGE_WIF && env.GCP_STORAGE_SERVICE_ACCOUNT === OPERATOR_SA);
  requireValue(typeof env.SUPABASE_ACCESS_TOKEN === "string" && env.SUPABASE_ACCESS_TOKEN.length > 0 && !/[\r\n]/.test(env.SUPABASE_ACCESS_TOKEN));
}

export function managementQuery({ env, fetchImpl = fetch, signal }) {
  requireMigrationContext(env);
  return async (query, { parameters = [], write = false } = {}) => {
    const response = await fetchImpl(`https://api.supabase.com/v1/projects/${SOURCE_REF}/database/query`, {
      method: "POST", headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, parameters, read_only: !write }), redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
    });
    if (response.status !== 200 && response.status !== 201) { await response.body?.cancel().catch(() => {}); fail(); }
    return json(await responseBytes(response, MAX_JSON_BYTES));
  };
}

const age = (recipient, fd) => spawn("/usr/bin/age", ["--encrypt", "--recipient", recipient], {
  stdio: ["pipe", fd ?? "ignore", "ignore"], env: { PATH: "/usr/bin:/bin", LANG: "C" },
});
async function encrypt(child, bytes, signal) {
  const completion = new Promise((done, reject) => {
    child.once("error", reject); child.once("close", (code) => code === 0 ? done() : reject(new Error("Encryption failed")));
  });
  try { await Promise.all([pipeline(Readable.from([bytes]), child.stdin, { signal }), completion]); }
  finally { if (child.exitCode === null) child.kill("SIGKILL"); }
}

// A complete encrypted receipt is replaced atomically, never a plaintext file.
// Only this directory is uploaded, including failed migration receipts.
export async function encryptedJournal(env, signal, spawnAge = age) {
  const recipient = env.SUPABASE_BACKUP_AGE_RECIPIENT;
  requireValue(typeof recipient === "string" && /^age1[a-z0-9]{58}$/.test(recipient));
  requireValue(typeof env.RUNNER_TEMP === "string" && isAbsolute(env.RUNNER_TEMP) && env.RUNNER_TEMP !== "/");
  const parent = await lstat(env.RUNNER_TEMP); requireValue(parent.isDirectory() && !parent.isSymbolicLink());
  await encrypt(spawnAge(recipient), Buffer.alloc(0), signal);
  const directory = join(env.RUNNER_TEMP, "storage-migration-encrypted");
  await mkdir(directory, { mode: 0o700 }); // Existing run outputs must not be reused implicitly.
  let revision = 0;
  return {
    async write(kind, bytes) {
      requireValue(["receipt", "backup", "snapshot"].includes(kind) && Buffer.isBuffer(bytes));
      const pending = join(directory, `pending-${++revision}.age`);
      let fd;
      try {
        fd = await open(pending, "wx", 0o600);
        await encrypt(spawnAge(recipient, fd.fd), bytes, signal);
        await fd.close(); fd = undefined;
        await rename(pending, join(directory, `${kind}.age`));
      } finally { await fd?.close().catch(() => {}); await rm(pending, { force: true }); }
    },
  };
}
