#!/usr/bin/env node
// Operator-only preservation archive and explicit source cutover freeze. No restore.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { link, lstat, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { FREEZE_SOURCE_SQL, UNFREEZE_SOURCE_SQL, INSPECT_CUTOVER_SCHEMA_SQL, INSPECT_CUTOVER_STATE_SQL, parseBackupOperation, SOURCE_GUARD_COUNT } from "./source-database-cutover.mjs";

export const SOURCE_REF = "aqvmuhqkaqedtxuqwhoq";
export const POOLER_URL = `https://api.supabase.com/v1/projects/${SOURCE_REF}/config/database/pooler`;
export const CA_URL = "https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt";
export const CA_SHA256 = "700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7";
export const CLIENT_MAJOR = 17;
export const ARCHIVE_NAME = "database-auth.pgdump.age";
// Supavisor may not forward startup PGOPTIONS. Establish the transaction mode
// in SQL and verify it on the server; pg_dump likewise opens its own READ ONLY
// snapshot transaction rather than relying on the startup default.
export const PROBE_SQL = `BEGIN READ ONLY;
SET LOCAL statement_timeout='10000';
SELECT current_setting('server_version_num')::integer,
  current_setting('transaction_read_only') = 'on',
  (rolsuper OR rolbypassrls), current_user = 'postgres',
  current_database() = 'postgres', to_regclass('auth.users') IS NOT NULL
FROM pg_catalog.pg_roles WHERE rolname = current_user;
COMMIT;`;
export const DUMP_ARGS = Object.freeze([
  "--format=custom", "--schema=public", "--schema=auth", "--strict-names",
  "--no-password", "--lock-wait-timeout=10000", "--quote-all-identifiers",
]);
const PG_BIN = `/usr/lib/postgresql/${CLIENT_MAJOR}/bin`;
const BASE_ENV = Object.freeze({ PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" });
const STAGES = new Set(["context", "prepare", "client-version", "recipient", "pooler", "certificate", "source-version", "cutover-inspect", "source-freeze", "source-unfreeze", "dump-encrypt", "publish", "interrupted"]);
const REASONS = new Set(["tls-certificate", "tls-hostname", "authentication", "startup-option", "connection", "process", "source-shape", "source-readonly", "source-rls", "source-role", "source-database", "source-auth", "source-major"]);

// Child errors may contain connection strings, SQL or row contents. Only these
// fixed classifications cross the logging boundary; the original text never does.
export function classifyProcessError(value) {
  if (/server certificate.*does not match host name/i.test(value)) return "tls-hostname";
  if (/certificate verify failed|root certificate|SSL error.*certificate/i.test(value)) return "tls-certificate";
  if (/password authentication failed|SASL authentication failed|Tenant or user not found/i.test(value)) return "authentication";
  if (/unsupported startup parameter|unrecognized configuration parameter|invalid command-line argument.*server process/i.test(value)) return "startup-option";
  if (/could not translate host name|connection refused|timeout expired|connection timed out|network is unreachable/i.test(value)) return "connection";
  return "process";
}

export class BackupError extends Error {
  constructor(stage, status, reason) {
    super("Database Auth backup failed.");
    this.stage = STAGES.has(stage) ? stage : "context";
    if (Number.isInteger(status) && status >= 100 && status <= 599) this.httpStatus = status;
    if (REASONS.has(reason)) this.reason = reason;
  }
}
export function diagnostic(error) {
  return { status: "failed", stage: error instanceof BackupError ? error.stage : "context",
    ...(error instanceof BackupError && error.httpStatus ? { httpStatus: error.httpStatus } : {}),
    ...(error instanceof BackupError && error.reason ? { reason: error.reason } : {}) };
}
function requireValue(ok, stage) { if (!ok) throw new BackupError(stage); }

export function validateContext(env) {
  requireValue(env.GITHUB_ACTIONS === "true" && env.GITHUB_REPOSITORY === "godhuu0505/mfmf"
    && env.GITHUB_REF === "refs/heads/main" && env.GITHUB_EVENT_NAME === "workflow_dispatch"
    && env.GITHUB_WORKFLOW_REF === "godhuu0505/mfmf/.github/workflows/backup-database-auth.yml@refs/heads/main"
    && env.SUPABASE_PROJECT_ID === SOURCE_REF, "context");
  for (const name of ["SUPABASE_ACCESS_TOKEN", "SUPABASE_DB_PASSWORD"]) {
    requireValue(typeof env[name] === "string" && env[name].length > 0 && env[name].length <= 16384
      && !/[\r\n\0]/.test(env[name]), "context");
  }
  requireValue(/^age1[023456789acdefghjklmnpqrstuvwxyz]{58}$/.test(env.SUPABASE_BACKUP_AGE_RECIPIENT ?? ""), "context");
  requireValue(typeof env.RUNNER_TEMP === "string" && isAbsolute(env.RUNNER_TEMP)
    && !/[\r\n\0]/.test(env.RUNNER_TEMP), "context");
}

export function selectPooler(rows) {
  requireValue(Array.isArray(rows) && rows.length > 0 && rows.length <= 16, "pooler");
  const primary = rows.filter((row) => row?.database_type === "PRIMARY");
  requireValue(primary.length > 0, "pooler");
  const hosts = new Set();
  for (const row of primary) {
    requireValue(typeof row.db_host === "string"
      && /^aws-[0-9]{1,2}-[a-z]{2}(?:-gov)?-[a-z]+-[0-9]\.pooler\.supabase\.com$/.test(row.db_host)
      && ["postgres", `postgres.${SOURCE_REF}`].includes(row.db_user)
      && row.db_name === "postgres"
      && ((row.pool_mode === "transaction" && row.db_port === 6543)
        || (row.pool_mode === "session" && row.db_port === 5432)), "pooler");
    hosts.add(row.db_host);
  }
  requireValue(hosts.size === 1, "pooler");
  // Supavisor's same host exposes session mode on 5432 even when the config
  // response describes its transaction listener. Never use a returned URI.
  return { host: [...hosts][0], port: "5432", user: `postgres.${SOURCE_REF}`, database: "postgres" };
}

async function boundedResponse(fetchImpl, url, options, stage, limit) {
  const response = await fetchImpl(url, { ...options, redirect: "error" });
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    throw new BackupError(stage, response.status);
  }
  const chunks = [];
  let size = 0;
  requireValue(response.body, stage);
  for await (const chunk of response.body) {
    size += chunk.length;
    requireValue(size <= limit, stage);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// Dependencies are injectable only through this module API for offline tests;
// the CLI accepts no arguments, connection URL, executable or output override.
export async function runBackup({ env = process.env, fetchImpl = fetch, spawnImpl = spawn,
  signal, operation = "preserve", timeoutMs = 20 * 60_000, maxArchiveBytes = 1024 ** 3 } = {}) {
  let stage = "context";
  let workDir;
  let outputDir;
  let ownsOutput = false;
  let succeeded = false;
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  signal?.addEventListener("abort", interrupt, { once: true });
  if (signal?.aborted) interrupt();
  const timer = setTimeout(interrupt, timeoutMs);
  const children = new Set();
  const stopChildren = () => { for (const child of children) child.kill("SIGKILL"); };
  controller.signal.addEventListener("abort", stopChildren);
  function start(command, args, childEnv, input = "ignore") {
    requireValue(!controller.signal.aborted, "interrupted");
    const child = spawnImpl(command, args, { env: childEnv, cwd: workDir,
      stdio: [input, "pipe", "pipe"], shell: false });
    let errorPrefix = Buffer.alloc(0);
    child.stderr.on("data", (chunk) => {
      if (errorPrefix.length < 4096) errorPrefix = Buffer.concat([errorPrefix, chunk]).subarray(0, 4096);
    });
    children.add(child);
    // An error result is consumed immediately, never rethrowing a child message.
    const done = new Promise((resolve) => {
      child.once("error", () => resolve(false));
      child.once("close", (code, killed) => { children.delete(child); resolve(code === 0 && !killed); });
    });
    return { child, done, failureReason: () => classifyProcessError(errorPrefix.toString("utf8")) };
  }
  async function capture(command, args, childEnv) {
    const { child, done, failureReason } = start(command, args, childEnv);
    const chunks = [];
    let size = 0;
    for await (const chunk of child.stdout) {
      size += chunk.length;
      requireValue(size <= 1024, stage);
      chunks.push(chunk);
    }
    if (!await done) throw new BackupError(stage, undefined, failureReason());
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  try {
    validateContext(env);
    requireValue(["preserve", "freeze-and-backup", "unfreeze"].includes(operation), "context");
    stage = "prepare";
    requireValue((await lstat(env.RUNNER_TEMP)).isDirectory(), stage);
    outputDir = join(env.RUNNER_TEMP, "database-auth-backup-encrypted");
    if (operation !== "unfreeze") {
      await mkdir(outputDir, { mode: 0o700 }); // Existing output, including a symlink, is refused.
      ownsOutput = true;
    }
    workDir = await mkdtemp(join(env.RUNNER_TEMP, "database-auth-work-"));
    const childBaseEnv = { ...BASE_ENV, HOME: workDir };
    stage = "client-version";
    for (const program of ["pg_dump", "psql"]) {
      const version = await capture(`${PG_BIN}/${program}`, ["--version"], childBaseEnv);
      requireValue(new RegExp(`^${program} \\(PostgreSQL\\) ${CLIENT_MAJOR}\\.[0-9]+(?:[ .].*)?$`).test(version), stage);
    }
    stage = "recipient";
    const recipientCheck = start("/usr/bin/age", ["--encrypt", "--recipient", env.SUPABASE_BACKUP_AGE_RECIPIENT], childBaseEnv, "pipe");
    recipientCheck.child.stdout.resume();
    recipientCheck.child.stdin.on("error", () => {});
    recipientCheck.child.stdin.end();
    requireValue(await recipientCheck.done, stage);
    stage = "pooler";
    const requestSignal = () => AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
    const config = await boundedResponse(fetchImpl, POOLER_URL,
      { headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` }, signal: requestSignal() }, stage, 64 * 1024);
    const connection = selectPooler(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(config)));
    stage = "certificate";
    const ca = await boundedResponse(fetchImpl, CA_URL, { signal: requestSignal() }, stage, 16 * 1024);
    requireValue(createHash("sha256").update(ca).digest("hex") === CA_SHA256, stage);
    const caFile = join(workDir, "supabase-root.crt");
    await writeFile(caFile, ca, { mode: 0o600, flag: "wx" }); // Public pinned CA, never a credential.
    const pgEnv = { ...childBaseEnv, PGHOST: connection.host, PGPORT: connection.port,
      PGUSER: connection.user, PGDATABASE: connection.database, PGPASSWORD: env.SUPABASE_DB_PASSWORD,
      PGSSLMODE: "verify-full", PGSSLROOTCERT: caFile, PGSSLMINPROTOCOLVERSION: "TLSv1.2",
      PGPASSFILE: "/dev/null", PGSERVICEFILE: "/dev/null", PGSYSCONFDIR: workDir,
      PGCONNECT_TIMEOUT: "15", PGAPPNAME: "mfmf-auth-backup",
      PGOPTIONS: "-c default_transaction_read_only=on -c statement_timeout=600000 -c lock_timeout=10000" };
    stage = "source-version";
    const probe = await capture(`${PG_BIN}/psql`, ["--no-psqlrc", "--no-password", "--quiet", "--tuples-only",
      "--no-align", "--set=ON_ERROR_STOP=1", "--command", PROBE_SQL], pgEnv);
    const match = /^([0-9]{6})\|([tf])\|([tf])\|([tf])\|([tf])\|([tf])$/.exec(probe);
    if (!match) throw new BackupError(stage, undefined, "source-shape");
    const probeReasons = ["source-readonly", "source-rls", "source-role", "source-database", "source-auth"];
    for (let i = 0; i < probeReasons.length; i++) {
      if (match[i + 2] !== "t") throw new BackupError(stage, undefined, probeReasons[i]);
    }
    const sourceMajor = Math.floor(Number(match[1]) / 10_000);
    if (sourceMajor < 15 || sourceMajor > CLIENT_MAJOR) throw new BackupError(stage, undefined, "source-major");
    const sqlArgs = (sql) => ["--no-psqlrc", "--no-password", "--quiet", "--tuples-only", "--no-align", "--set=ON_ERROR_STOP=1", "--command", sql];
    if (operation === "freeze-and-backup" || operation === "unfreeze") {
      stage = operation === "freeze-and-backup" ? "source-freeze" : "source-unfreeze";
      const result = await capture(`${PG_BIN}/psql`, sqlArgs(operation === "freeze-and-backup" ? FREEZE_SOURCE_SQL : UNFREEZE_SOURCE_SQL),
        { ...pgEnv, PGOPTIONS: "-c default_transaction_read_only=off -c statement_timeout=60000 -c lock_timeout=10000" });
      requireValue(result === (operation === "freeze-and-backup" ? `t|${SOURCE_GUARD_COUNT}` : `f|${SOURCE_GUARD_COUNT}`), stage);
      if (operation === "unfreeze") {
        succeeded = true;
        return { status: "unfrozen", sourceWrites: "enabled", archive: "not-created" };
      }
    }
    stage = "cutover-inspect";
    const schema = await capture(`${PG_BIN}/psql`, sqlArgs(INSPECT_CUTOVER_SCHEMA_SQL), pgEnv);
    requireValue(["t", "f"].includes(schema), stage);
    let frozen = false;
    if (schema === "t") {
      const state = await capture(`${PG_BIN}/psql`, sqlArgs(INSPECT_CUTOVER_STATE_SQL), pgEnv);
      requireValue([`t|${SOURCE_GUARD_COUNT}`, `f|${SOURCE_GUARD_COUNT}`].includes(state), stage);
      frozen = state === `t|${SOURCE_GUARD_COUNT}`;
    }
    requireValue(operation !== "freeze-and-backup" || frozen, stage);
    stage = "dump-encrypt";
    const partialPath = join(workDir, "archive.partial.age");
    const output = createWriteStream(partialPath, { mode: 0o600, flags: "wx" });
    const age = start("/usr/bin/age", ["--encrypt", "--recipient", env.SUPABASE_BACKUP_AGE_RECIPIENT], childBaseEnv, "pipe");
    const dump = start(`${PG_BIN}/pg_dump`, [...DUMP_ARGS, ...(schema === "t" ? ["--schema=mfmf_cutover"] : [])], pgEnv);
    let plaintextBytes = 0;
    let prefix = Buffer.alloc(0);
    const count = new Transform({ transform(chunk, _encoding, callback) {
      plaintextBytes += chunk.length;
      if (prefix.length < 5) prefix = Buffer.concat([prefix, chunk]).subarray(0, 5);
      if (plaintextBytes > maxArchiveBytes || (prefix.length === 5 && !prefix.equals(Buffer.from("PGDMP")))) {
        callback(new BackupError("dump-encrypt"));
      } else callback(null, chunk);
    } });
    const requireExitZero = (done) => done.then((ok) => { requireValue(ok, "dump-encrypt"); return true; });
    const results = await Promise.allSettled([
      pipeline(dump.child.stdout, count, age.child.stdin, { signal: controller.signal }),
      pipeline(age.child.stdout, output, { signal: controller.signal }),
      requireExitZero(dump.done), requireExitZero(age.done),
    ].map((promise) => promise.catch((error) => { controller.abort(); throw error; })));
    requireValue(results.every((result) => result.status === "fulfilled")
      && results[2].value === true && results[3].value === true
      && plaintextBytes >= 5 && prefix.equals(Buffer.from("PGDMP")), stage);
    stage = "publish";
    const file = await open(partialPath, "r+");
    let ciphertextBytes;
    try {
      const expectedHeader = Buffer.from("age-encryption.org/v1\n-");
      const header = Buffer.alloc(expectedHeader.length);
      await file.read(header, 0, header.length, 0);
      requireValue(header.equals(expectedHeader), stage);
      const info = await file.stat();
      requireValue(info.isFile() && (info.mode & 0o777) === 0o600 && info.size > plaintextBytes, stage);
      ciphertextBytes = info.size;
      await file.sync();
    } finally { await file.close(); }
    requireValue(!controller.signal.aborted, "interrupted");
    await link(partialPath, join(outputDir, ARCHIVE_NAME)); // Exclusive publish; never replace an archive.
    succeeded = true;
    return { status: "encrypted", schemas: schema === "t" ? 3 : 2, frozen, clientMajor: CLIENT_MAJOR, sourceMajor,
      plaintextBytes, ciphertextBytes, consistency: "single-pg-dump-snapshot", restore: "not-verified" };
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError(controller.signal.aborted ? "interrupted" : stage);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", interrupt);
    controller.abort();
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
    if (ownsOutput && !succeeded) await rm(outputDir, { recursive: true, force: true }).catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGINT", () => controller.abort());
  process.stdout.on("error", () => { controller.abort(); process.exitCode = 1; });
  process.stderr.on("error", () => { process.exitCode = 1; });
  try {
    requireValue(process.argv.length === 2, "context");
    requireValue(typeof process.env.GITHUB_EVENT_PATH === "string", "context");
    const eventInfo = await lstat(process.env.GITHUB_EVENT_PATH);
    requireValue(eventInfo.isFile() && !eventInfo.isSymbolicLink() && eventInfo.size <= 65_536, "context");
    const operation = parseBackupOperation(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
    const result = await runBackup({ signal: controller.signal, operation });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(diagnostic(error))}\n`);
    process.exitCode = 1;
  }
}
