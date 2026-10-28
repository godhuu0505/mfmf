import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const PROJECT = "mfmf-499612";
const ORIGIN = "https://mfmf-candidate-wspqvmhj6q-an.a.run.app";
const INSTANCE = `${PROJECT}:asia-northeast1:mfmf-db`;
const SOCKETS = "/tmp/mfmf-cloudsql";
const fail = () => { throw new Error("GCP database runtime configuration is invalid; values withheld."); };

export function runtimePlan(env, entropy = randomBytes) {
  const enabled = env.GCP_AUTH_ENABLED ?? "false";
  const browser = env.NEXT_PUBLIC_GCP_AUTH_ENABLED ?? "false";
  if (!["true", "false"].includes(enabled) || browser !== enabled) fail();
  if (enabled === "false") return { database: false, nextEnv: { ...env }, processes: [] };
  if (env.GCP_PROJECT_ID !== PROJECT || env.GCP_AUTH_ORIGIN !== ORIGIN ||
      !/^[A-Za-z0-9_-]{32,128}$/.test(env.MFMF_DATABASE_PASSWORD ?? "") ||
      !/^[A-Za-z0-9_-]{20,256}$/.test(env.IDENTITY_PLATFORM_API_KEY ?? "") ||
      env.MFMF_DATABASE_JWT_SECRET !== undefined) fail();
  const key = entropy(32);
  if (!Buffer.isBuffer(key) || key.length !== 32) fail();
  const jwt = key.toString("base64");
  const nextEnv = { ...env, MFMF_DATABASE_JWT_SECRET: jwt };
  delete nextEnv.MFMF_DATABASE_PASSWORD;
  const dbUri = `postgresql://authenticator:${encodeURIComponent(env.MFMF_DATABASE_PASSWORD)}@localhost/mfmf?host=${encodeURIComponent(`${SOCKETS}/${INSTANCE}`)}&sslmode=disable&application_name=mfmf-postgrest`;
  const base = { PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" };
  return {
    database: true,
    nextEnv,
    processes: [
      { stage: "database-connector", executable: "/usr/local/bin/cloud-sql-proxy", args: ["--private-ip", `--unix-socket=${SOCKETS}`, "--max-connections=4", "--quiet", INSTANCE], env: base },
      { stage: "database-api", executable: "/usr/local/bin/postgrest", args: [], env: {
        ...base, PGRST_DB_URI: dbUri, PGRST_DB_SCHEMAS: "public", PGRST_DB_ANON_ROLE: "anon",
        PGRST_DB_POOL: "2", PGRST_DB_POOL_ACQUISITION_TIMEOUT: "5", PGRST_DB_POOL_MAX_IDLE_TIME: "30",
        PGRST_DB_POOL_MAX_LIFETIME: "600", PGRST_DB_CONFIG: "false", PGRST_DB_TX_END: "commit",
        PGRST_SERVER_HOST: "127.0.0.1", PGRST_SERVER_PORT: "3001", PGRST_ADMIN_SERVER_PORT: "3002",
        PGRST_JWT_SECRET: jwt, PGRST_JWT_SECRET_IS_BASE64: "true", PGRST_JWT_AUD: "mfmf-internal-database",
        PGRST_OPENAPI_MODE: "disabled", PGRST_LOG_LEVEL: "crit", PGRST_DB_CHANNEL_ENABLED: "false",
      } },
    ],
  };
}

export async function startRuntime(env = process.env, { spawnImpl = spawn, fetchImpl = fetch, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), log = console.error } = {}) {
  const plan = runtimePlan(env);
  const children = [];
  let stopping = false;
  let failure = false;
  const stop = (failed = false) => {
    failure ||= failed;
    if (stopping) return;
    stopping = true;
    for (const child of children) child.kill("SIGTERM");
    setTimeout(() => {
      for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
      process.exit(failure ? 1 : 0);
    }, 8_000).unref();
  };
  const launch = ({ stage, executable, args, env: childEnv }, next = false) => {
    // The database connector/API can log DSNs, SQL or claim details on failures.
    // Only a fixed component name and exit status are emitted by the supervisor.
    const child = spawnImpl(executable, args, { env: childEnv, stdio: next ? ["ignore", "inherit", "inherit"] : ["ignore", "ignore", "ignore"] });
    children.push(child);
    child.on("error", () => { log(`Runtime component could not start: ${stage}. Details withheld.`); stop(true); });
    child.on("exit", (code, signal) => {
      if (!stopping) { log(`Runtime component stopped: ${stage}; successful=${code === 0 && signal === null}.`); stop(true); }
      if (stopping && children.every((item) => item.exitCode !== null || item.signalCode !== null)) process.exit(failure ? 1 : 0);
    });
  };
  process.once("SIGTERM", () => stop());
  process.once("SIGINT", () => stop());
  if (plan.database) {
    await mkdir(SOCKETS, { recursive: true, mode: 0o700 });
    for (const item of plan.processes) launch(item);
    let ready = false;
    for (let count = 0; count < 90 && !stopping; count++) {
      try {
        const response = await fetchImpl("http://127.0.0.1:3002/ready", { redirect: "error", signal: AbortSignal.timeout(1_000) });
        ready = response.status === 200;
        await response.body?.cancel();
      } catch { /* bounded retry while the connector and schema cache start */ }
      if (ready) break;
      await wait(1_000);
    }
    if (!ready || stopping) { log("Internal database readiness failed; Next.js was not started."); stop(true); return; }
  }
  launch({ stage: "application", executable: process.execPath, args: ["/app/server.js"], env: plan.nextEnv }, true);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startRuntime().catch(() => { console.error("Runtime startup failed; details withheld."); process.exitCode = 1; });
}
