// Fixed-target Standard backup retention. No database SQL, creation, restore,
// permission/config changes, or arbitrary-target deletion. Called by the fixed Job.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { validateResource, URLS } from "./bootstrap-database.mjs";

export const RETENTION = Object.freeze({
  project: "mfmf-499612", instance: "mfmf-db", region: "asia-northeast1",
  job: "mfmf-db-retention", bucket: "mfmf-499612-backup-ops", object: "retention/latest.json",
  format: "mfmf-database-retention-v1", policy: "owned-preupgrade-14d-newer-48h-v1",
  minimumAgeDays: 14, newerMaximumAgeHours: 48, receiptMaximumAgeHours: 30,
  maximumCount: 8, maximumBytes: "1073741824",
});
const DAY = 86_400_000;
const API = `https://sqladmin.googleapis.com/v1/projects/${RETENTION.project}`;
const OBJECT = `https://storage.googleapis.com/storage/v1/b/${RETENTION.bucket}/o/${encodeURIComponent(RETENTION.object)}`;
const OWNED = /^mfmf-managed-preupgrade-v1:[a-f0-9]{40}$/;
const NAME = /^projects\/mfmf-499612\/backups\/[A-Za-z0-9_-]{1,200}$/;
const DECIMAL = /^(0|[1-9][0-9]{0,18})$/;
const GENERATION = /^[1-9][0-9]{0,19}$/;
const SHA = /^[a-f0-9]{64}$/;
const STAGES = new Set(["context", "implementation", "instance", "operations", "list", "capacity", "backup", "newer", "drift", "delete", "poll", "absence", "receipt-read", "receipt-write", "receipt-verify", "readiness", "timeout"]);
const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const exact = (v, keys) => plain(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const ERROR_DETAILS = new WeakMap();
const integer = (v, max = 10000) => Number.isSafeInteger(v) && v >= 0 && v <= max;
export class RetentionError extends Error {
  constructor(stage, status) {
    super(`Database backup retention failed: stage=${STAGES.has(stage) ? stage : "context"}${Number.isInteger(status) && status >= 400 && status <= 599 ? ` http=${status}` : ""}; details withheld.`);
    ERROR_DETAILS.set(this, { status: "failed", component: "database-retention", stage: STAGES.has(stage) ? stage : "context",
      ...(Number.isInteger(status) && status >= 400 && status <= 599 ? { httpStatus: status } : {}) });
  }
}
export const retentionDiagnostic = (error) => ERROR_DETAILS.has(error) ? { ...ERROR_DETAILS.get(error) } : null;
const requireValue = (ok, stage) => { if (!ok) throw new RetentionError(stage); };
const instant = (v, stage = "backup") => {
  requireValue(typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(v) && Number.isFinite(Date.parse(v)), stage);
  return Date.parse(v);
};
const bytes = (b) => {
  requireValue(typeof b?.maxChargeableBytes === "string" && DECIMAL.test(b.maxChargeableBytes), "capacity");
  return BigInt(b.maxChargeableBytes);
};
export async function retentionImplementationSha256() {
  const digest = createHash("sha256");
  try {
    for (const file of ["bootstrap-database.mjs", "database-backup-retention.mjs", "database-prebackup.mjs"]) {
      const data = await readFile(new URL(file, import.meta.url));
      digest.update(`${file}\0${data.length}\0`); digest.update(data);
    }
    return digest.digest("hex");
  } catch { throw new RetentionError("implementation"); }
}
export function retentionApi({ accessToken, fetchImpl = fetch, signal = AbortSignal.timeout(12 * 60_000) }) {
  requireValue(typeof accessToken === "string" && /^[\x21-\x7e]{1,16384}$/.test(accessToken), "context");
  return async (url, stage, { method = "GET", body, missing = false, limit = 1_048_576 } = {}) => {
    let response;
    try {
      response = await fetchImpl(url, { method, redirect: "error", cache: "no-store",
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        headers: { Authorization: `Bearer ${accessToken}`, "X-Goog-User-Project": RETENTION.project,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch { throw new RetentionError(stage); }
    if (missing && response.status === 404) { await response.body?.cancel().catch(() => {}); return null; }
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new RetentionError(stage, response.status); }
    try {
      const chunks = []; let length = 0;
      for await (const chunk of response.body) { length += chunk.length; requireValue(length <= limit, stage); chunks.push(Buffer.from(chunk)); }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    } catch { throw new RetentionError(stage); }
  };
}
export async function retentionInstance(api, now = Date.now()) {
  const value = await api(URLS.instance, "instance");
  try { validateResource("instance", value); } catch { throw new RetentionError("instance"); }
  requireValue(instant(value.createTime, "instance") <= now && typeof value.settings.settingsVersion === "string" && GENERATION.test(value.settings.settingsVersion), "instance");
  return { createTime: value.createTime, settingsVersion: value.settings.settingsVersion };
}
async function noActiveOperations(api) {
  let token; const seen = new Set();
  for (let page = 0; page < 10; page++) {
    const url = new URL(`${API}/operations`); url.searchParams.set("instance", RETENTION.instance); url.searchParams.set("maxResults", "1000");
    if (token) url.searchParams.set("pageToken", token);
    const result = await api(url.toString(), "operations");
    requireValue(plain(result) && Array.isArray(result.items ?? []) && (result.items?.length ?? 0) <= 1000 && !(result.warnings?.length), "operations");
    for (const op of result.items ?? []) requireValue(op?.targetProject === RETENTION.project && op.targetId === RETENTION.instance && op.status === "DONE", "operations");
    token = result.nextPageToken;
    if (token === undefined || token === "") return;
    requireValue(typeof token === "string" && token.length <= 4096 && !/[\x00-\x1f\x7f]/.test(token) && !seen.has(token), "operations"); seen.add(token);
  }
  throw new RetentionError("operations");
}
export async function retentionInventory(api) {
  let token; const seen = new Set(); const names = new Set(); const rows = [];
  for (let page = 0; page < 10; page++) {
    const url = new URL(`${API}/backups`); url.searchParams.set("filter", `instance:${RETENTION.instance}`); url.searchParams.set("pageSize", "1000");
    if (token) url.searchParams.set("pageToken", token);
    const result = await api(url.toString(), "list");
    requireValue(plain(result) && Array.isArray(result.backups ?? []) && (result.backups?.length ?? 0) <= 1000 && !(result.warnings?.length), "list");
    for (const row of result.backups ?? []) {
      requireValue(plain(row) && typeof row.name === "string" && NAME.test(row.name) && row.instance === RETENTION.instance
        && ["AUTOMATED", "ON_DEMAND", "FINAL"].includes(row.type) && !names.has(row.name), "list");
      names.add(row.name); rows.push(row);
    }
    token = result.nextPageToken;
    if (token === undefined || token === "") {
      // ListBackups legitimately omits maxChargeableBytes and other detail.
      // Hydrate fixed listed names, retaining identity/type equality and never
      // interpreting missing size as zero. A partial list/detail fails closed.
      const hydrated = [];
      for (const summary of rows) {
        const value = await api(`https://sqladmin.googleapis.com/v1/${summary.name}`, "backup");
        requireValue(plain(value) && value.name === summary.name && value.instance === summary.instance && value.type === summary.type, "list");
        hydrated.push(value);
      }
      return hydrated;
    }
    requireValue(typeof token === "string" && token.length <= 4096 && !/[\x00-\x1f\x7f]/.test(token) && !seen.has(token), "list"); seen.add(token);
  }
  throw new RetentionError("list");
}
export function retentionCapacity(rows, reserveSlot = false) {
  const manual = rows.filter((row) => row.type === "ON_DEMAND");
  const total = manual.reduce((sum, row) => sum + bytes(row), 0n);
  requireValue(manual.length <= RETENTION.maximumCount && total <= BigInt(RETENTION.maximumBytes)
    && (!reserveSlot || (manual.length < RETENTION.maximumCount && total < BigInt(RETENTION.maximumBytes))), "capacity");
  return { onDemandCount: manual.length, onDemandBytes: total.toString() };
}
export function validateRetentionBackup(b, birth, now) {
  requireValue(plain(b) && typeof b.name === "string" && NAME.test(b.name) && b.instance === RETENTION.instance
    && ["AUTOMATED", "ON_DEMAND", "FINAL"].includes(b.type) && b.state === "SUCCESSFUL" && b.location === RETENTION.region
    && b.databaseVersion === "POSTGRES_17" && ["SNAPSHOT", "PHYSICAL", "DEFAULT_SNAPSHOT"].includes(b.backupKind)
    && !b.error && !b.instanceDeletionTime, "backup");
  const start = instant(b.backupInterval?.startTime); const end = instant(b.backupInterval?.endTime);
  requireValue(start >= instant(birth, "instance") && end >= start && end <= now
    && (b.expiryTime == null || instant(b.expiryTime) >= now + DAY), "backup"); bytes(b);
  return { start, end };
}
function pinnedBackup(b) {
  return JSON.stringify([b.name, b.instance, b.type, b.state, b.location, b.databaseVersion, b.backupKind,
    b.description ?? null, b.expiryTime ?? null, b.backupInterval?.startTime, b.backupInterval?.endTime, b.maxChargeableBytes, b.instanceDeletionTime ?? null, b.error ?? null]);
}
function planRetention(rows, birth, now) {
  retentionCapacity(rows);
  const candidates = [];
  for (const b of rows) {
    if (b.type !== "ON_DEMAND" || typeof b.description !== "string" || !OWNED.test(b.description)) continue;
    const age = validateRetentionBackup(b, birth, now);
    if (age.start <= now - RETENTION.minimumAgeDays * DAY && age.end <= now - RETENTION.minimumAgeDays * DAY) candidates.push(b);
  }
  const recoveryPoints = rows.filter((b) => {
    if (b.state !== "SUCCESSFUL") return false;
    try { return validateRetentionBackup(b, birth, now).start >= now - RETENTION.newerMaximumAgeHours * 3600000; } catch { return false; }
  }).sort((a, b) => instant(b.backupInterval.startTime) - instant(a.backupInterval.startTime));
  // Even an empty cleanup must prove the expected daily recovery point exists.
  requireValue(recoveryPoints.length > 0, "newer");
  for (const b of candidates) requireValue(recoveryPoints.some((n) => n.name !== b.name && instant(n.backupInterval.startTime) > instant(b.backupInterval.endTime)), "newer");
  return { candidates, recoveryPoints };
}
function receiptMetadata(value) {
  requireValue(plain(value) && value.bucket === RETENTION.bucket && value.name === RETENTION.object
    && typeof value.generation === "string" && GENERATION.test(value.generation)
    && typeof value.size === "string" && DECIMAL.test(value.size) && BigInt(value.size) <= 8192n
    && value.contentType === "application/json", "receipt-read");
  return value.generation;
}
export async function readRetentionReceipt(api, { missing = false } = {}) {
  const metadata = await api(OBJECT, "receipt-read", { missing, limit: 8192 });
  if (metadata === null) return null;
  const generation = receiptMetadata(metadata);
  const receipt = await api(`${OBJECT}?alt=media&generation=${generation}`, "receipt-read", { limit: 8192 });
  return { generation, receipt };
}
async function writeReceipt(api, receipt, generation) {
  const url = new URL(`https://storage.googleapis.com/upload/storage/v1/b/${RETENTION.bucket}/o`);
  url.searchParams.set("uploadType", "media"); url.searchParams.set("name", RETENTION.object); url.searchParams.set("ifGenerationMatch", generation);
  const created = await api(url.toString(), "receipt-write", { method: "POST", body: receipt, limit: 8192 });
  const next = receiptMetadata(created); requireValue(next !== generation, "receipt-write");
  const verified = await readRetentionReceipt(api);
  requireValue(verified.generation === next && JSON.stringify(verified.receipt) === JSON.stringify(receipt), "receipt-verify");
  return next;
}
const RECEIPT_KEYS = ["format", "policy", "implementationSha256", "sourceCommit", "project", "instance", "instanceCreateTime", "status", "startedAt", "completedAt", "listedCount", "deletedCount", "onDemandCount", "onDemandBytes"];
function validateReceipt(r, instance, hash, now) {
  requireValue(exact(r, RECEIPT_KEYS) && r.format === RETENTION.format && r.policy === RETENTION.policy
    && r.project === RETENTION.project && r.instance === RETENTION.instance && r.instanceCreateTime === instance.createTime
    && typeof r.implementationSha256 === "string" && SHA.test(r.implementationSha256) && r.implementationSha256 === hash
    && typeof r.sourceCommit === "string" && /^[a-f0-9]{40}$/.test(r.sourceCommit) && r.status === "success"
    && integer(r.listedCount) && integer(r.deletedCount, 8) && integer(r.onDemandCount, 8)
    && typeof r.onDemandBytes === "string" && DECIMAL.test(r.onDemandBytes) && BigInt(r.onDemandBytes) <= BigInt(RETENTION.maximumBytes), "readiness");
  const started = instant(r.startedAt, "readiness"); const completed = instant(r.completedAt, "readiness");
  requireValue(started >= now - RETENTION.receiptMaximumAgeHours * 3600000 && completed >= started && completed <= now
    && completed - started <= 15 * 60000, "readiness");
}
export async function verifyRetentionReadiness({ accessToken, fetchImpl = fetch, now = () => Date.now() }) {
  const api = retentionApi({ accessToken, fetchImpl });
  const instance = await retentionInstance(api, now());
  const saved = await readRetentionReceipt(api);
  const implementation = await retentionImplementationSha256();
  validateReceipt(saved.receipt, instance, implementation, now());
  return { instanceCreateTime: instance.createTime, generation: saved.generation, implementationSha256: implementation };
}
export async function runDatabaseBackupRetention({ env, accessToken, fetchImpl = fetch, now = () => Date.now(),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), maxPolls = 120 }) {
  requireValue(env.CLOUD_RUN_JOB === RETENTION.job && env.CLOUD_RUN_TASK_COUNT === "1" && env.CLOUD_RUN_TASK_INDEX === "0"
    && env.CLOUD_RUN_TASK_ATTEMPT === "0" && /^[a-f0-9]{40}$/.test(env.MFMF_BACKUP_DEPLOY_SHA ?? ""), "context");
  const started = now(); const deadline = started + 12 * 60000;
  const api = retentionApi({ accessToken, fetchImpl });
  const instance = await retentionInstance(api, now()); await noActiveOperations(api);
  const existing = await readRetentionReceipt(api, { missing: true });
  // A fresh in-progress receipt fences concurrent Job executions. A stale one
  // needs operator reconciliation; a later schedule does not guess success.
  requireValue(existing === null || (plain(existing.receipt) && ["success", "failed"].includes(existing.receipt.status)), "readiness");
  const receipt = { format: RETENTION.format, policy: RETENTION.policy, implementationSha256: await retentionImplementationSha256(),
    sourceCommit: env.MFMF_BACKUP_DEPLOY_SHA, project: RETENTION.project, instance: RETENTION.instance,
    instanceCreateTime: instance.createTime, status: "running", startedAt: new Date(started).toISOString(), completedAt: null,
    listedCount: 0, deletedCount: 0, onDemandCount: 0, onDemandBytes: "0" };
  let generation = await writeReceipt(api, receipt, existing?.generation ?? "0");
  try {
    const rows = await retentionInventory(api); const plan = planRetention(rows, instance.createTime, now());
    receipt.listedCount = rows.length;
    for (const old of plan.candidates) {
      requireValue(now() < deadline, "timeout");
      const current = await retentionInstance(api, now());
      requireValue(JSON.stringify(current) === JSON.stringify(instance), "drift"); await noActiveOperations(api);
      const inventory = await retentionInventory(api); const fresh = planRetention(inventory, instance.createTime, now());
      const candidate = fresh.candidates.find((b) => b.name === old.name);
      requireValue(candidate && pinnedBackup(candidate) === pinnedBackup(old), "drift");
      const saved = await api(`https://sqladmin.googleapis.com/v1/${old.name}`, "backup");
      requireValue(pinnedBackup(saved) === pinnedBackup(old), "drift");
      const newer = fresh.recoveryPoints.find((b) => b.name !== old.name && instant(b.backupInterval.startTime) > instant(old.backupInterval.endTime));
      const proof = await api(`https://sqladmin.googleapis.com/v1/${newer.name}`, "newer");
      requireValue(pinnedBackup(proof) === pinnedBackup(newer), "drift");
      validateRetentionBackup(proof, instance.createTime, now());
      requireValue(instant(proof.backupInterval.startTime) >= now() - 48 * 3600000, "newer");
      const fence = await readRetentionReceipt(api);
      requireValue(fence.generation === generation && fence.receipt.status === "running", "drift");
      // DELETE is sent once. No API ETag/precondition exists; fixed immutable
      // backup ID + immediate rechecks and operator exclusion are the boundary.
      let operation = await api(`https://sqladmin.googleapis.com/v1/${old.name}`, "delete", { method: "DELETE" });
      let operationName; let done = false;
      for (let poll = 0; poll < maxPolls; poll++) {
        requireValue(now() < deadline && plain(operation) && /^[A-Za-z0-9_-]{1,200}$/.test(operation.name ?? "")
          && operation.targetProject === RETENTION.project && operation.targetId === RETENTION.instance
          && operation.operationType === "DELETE_BACKUP" && ["PENDING", "RUNNING", "DONE"].includes(operation.status)
          && !operation.error && (!operationName || operation.name === operationName), "poll");
        operationName = operation.name;
        if (operation.status === "DONE") { done = true; break; }
        await wait(5000); operation = await api(`${API}/operations/${operationName}`, "poll");
      }
      requireValue(done, "timeout");
      requireValue(await api(`https://sqladmin.googleapis.com/v1/${old.name}`, "absence", { missing: true }) === null, "absence");
      requireValue(!(await retentionInventory(api)).some((b) => b.name === old.name), "absence");
      receipt.deletedCount++;
    }
    const final = await retentionInventory(api); const finalPlan = planRetention(final, instance.createTime, now());
    requireValue(finalPlan.candidates.length === 0, "drift");
    requireValue(JSON.stringify(await retentionInstance(api, now())) === JSON.stringify(instance), "drift"); await noActiveOperations(api);
    Object.assign(receipt, retentionCapacity(final), { status: "success", completedAt: new Date(now()).toISOString() });
    requireValue(now() < deadline, "timeout");
    generation = await writeReceipt(api, receipt, generation);
    return { status: "verified", policy: RETENTION.policy, listedCount: receipt.listedCount, deletedCount: receipt.deletedCount,
      onDemandCount: receipt.onDemandCount, onDemandBytes: receipt.onDemandBytes, receiptVerified: true };
  } catch (error) {
    // Best-effort failure state; never publish success or retry a DELETE. The
    // preceding running generation remains a rejecting fence if this fails.
    try { await writeReceipt(api, { ...receipt, status: "failed", completedAt: new Date(now()).toISOString() }, generation); } catch { /* fixed failure below */ }
    throw error instanceof RetentionError ? error : new RetentionError("context");
  }
}
