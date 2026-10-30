import { verifyRetentionReadiness, retentionApi, retentionInventory, retentionCapacity } from "./database-backup-retention.mjs";

// Called only while the database advisory transaction lock is held, and only
// when the checksum ledger reports pending SQL. Never reads database contents.
const PROJECT = "mfmf-499612";
const INSTANCE = "mfmf-db";
const API = `https://sqladmin.googleapis.com/v1/projects/${PROJECT}`;
const DAY = 86_400_000;
const MAX_ON_DEMAND_COUNT = 8;
const MAX_ON_DEMAND_BYTES = 1_073_741_824n;
const fail = (stage, status) => { throw new Error(`Database prebackup failed: stage=${stage}${status ? ` http=${status}` : ""}; details withheld.`); };
const backupName = (value) => typeof value === "string" && /^projects\/mfmf-499612\/backups\/[A-Za-z0-9_-]{1,200}$/.test(value);
const chargeableBytes = (backup) => {
  const value = backup?.maxChargeableBytes;
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(value)) fail("backup-capacity");
  return BigInt(value);
};

export async function ensurePreMigrationBackup({ env, accessToken, fetchImpl = fetch,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = () => Date.now(), maxPolls = 180 }) {
  if (env.CLOUD_RUN_JOB !== "mfmf-db-operator" || env.MFMF_DB_OPERATION !== "upgrade"
    || !/^[a-f0-9]{40}$/.test(env.MFMF_DB_DEPLOY_SHA ?? "")
    || typeof accessToken !== "string" || !accessToken || /[\r\n]/.test(accessToken)) fail("context");
  // A Standard backup has no provider-enforced expiry. Require a current,
  // implementation-bound external cleanup contract BEFORE creating one.
  const readiness = await verifyRetentionReadiness({ accessToken, fetchImpl, now });
  const description = `mfmf-managed-preupgrade-v1:${env.MFMF_DB_DEPLOY_SHA}`;
  const request = async (url, stage, body) => {
    let response;
    try {
      response = await fetchImpl(url, { method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(30_000),
        headers: { Authorization: `Bearer ${accessToken}`, "X-Goog-User-Project": PROJECT,
          ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { fail(stage); }
    if (!response.ok) { await response.body?.cancel(); fail(stage, response.status); }
    try {
      const chunks = []; let length = 0;
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > 1_048_576) throw new Error();
        chunks.push(Buffer.from(chunk));
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch { fail(stage); }
  };
  let onDemandCount = 0; let onDemandBytes = 0n;
  const verify = async (backup, expectedName, replacedBytes = 0n, createdAfter) => {
    const expiry = Date.parse(backup?.expiryTime);
    const started = Date.parse(backup?.backupInterval?.startTime);
    const ended = Date.parse(backup?.backupInterval?.endTime);
    if (!backupName(backup?.name) || backup.name !== expectedName || backup.instance !== INSTANCE || backup.description !== description
      || backup.type !== "ON_DEMAND" || backup.state !== "SUCCESSFUL" || backup.location !== "asia-northeast1"
      || (backup.expiryTime != null && (!Number.isFinite(expiry) || expiry < now() + DAY || expiry > now() + 14 * DAY + 60_000))
      || started < Date.parse(readiness.instanceCreateTime)
      // startTime, not completion, bounds the writes guaranteed to be included.
      || !Number.isFinite(started) || started < now() - 15 * 60_000 || started > now() + 30_000
      || !Number.isFinite(ended) || ended < started || ended > now() + 30_000
      || (createdAfter !== undefined && started < createdAfter - 30_000)
      || backup.error) fail("verify-backup");
    if (onDemandBytes - replacedBytes + chargeableBytes(backup) > MAX_ON_DEMAND_BYTES) fail("backup-capacity");
    // Recheck after completion: a concurrent cleanup marks its receipt running,
    // and a recreated instance or changed retention implementation cannot pass.
    const finalReadiness = await verifyRetentionReadiness({ accessToken, fetchImpl, now });
    if (JSON.stringify(finalReadiness) !== JSON.stringify(readiness)) fail("retention-drift");
    const inventory = await retentionInventory(retentionApi({ accessToken, fetchImpl }));
    retentionCapacity(inventory);
    if (inventory.filter((row) => row.name === backup.name && row.type === "ON_DEMAND" && row.description === description).length !== 1) fail("verify-backup");
    return { verified: true, retentionMode: "verified-external-cleanup", minimumRetentionDays: 14, cleanupReceiptMaximumAgeHours: 30 };
  };
  // A lost create response must not produce one indefinite duplicate per retry.
  // Listing requires completeness. A prior pending/failed/stale marker stops
  // for operator inspection instead of silently creating another backup.
  const listed = await retentionInventory(retentionApi({ accessToken, fetchImpl }));
  const capacity = retentionCapacity(listed);
  onDemandCount = capacity.onDemandCount; onDemandBytes = BigInt(capacity.onDemandBytes);
  const matches = listed.filter((backup) => backup.description === description);
  if (matches.length > 1) fail("list-backups");
  if (matches.length === 1) {
    if (matches[0].type !== "ON_DEMAND") fail("verify-backup");
    return verify(await request(`https://sqladmin.googleapis.com/v1/${matches[0].name}`, "get-backup"),
      matches[0].name, chargeableBytes(matches[0]));
  }
  // All manual backups count, including other markers. Never delete recovery
  // points to make room. A new backup's size is known only after creation.
  if (onDemandCount >= MAX_ON_DEMAND_COUNT || onDemandBytes >= MAX_ON_DEMAND_BYTES) fail("backup-capacity");
  const createdAfter = now();
  let operation = await request(`${API}/backups`, "create-backup", {
    instance: INSTANCE, description, location: "asia-northeast1", ttlDays: "14",
  });
  let operationName;
  for (let poll = 0; poll < maxPolls; poll++) {
    if (!operation || !/^[A-Za-z0-9_-]{1,200}$/.test(operation.name ?? "")
      || operation.targetProject !== PROJECT || operation.targetId !== INSTANCE
      || !["BACKUP_VOLUME", "BACKUP"].includes(operation.operationType)
      || !["PENDING", "RUNNING", "DONE"].includes(operation.status)
      || operation.error || (operationName && operation.name !== operationName)) fail("backup-operation");
    operationName = operation.name;
    if (operation.status === "DONE") {
      if (!backupName(operation.backupContext?.name)) fail("backup-operation");
      return verify(await request(`https://sqladmin.googleapis.com/v1/${operation.backupContext.name}`, "get-backup"),
        operation.backupContext.name, 0n, createdAfter);
    }
    await wait(5_000);
    operation = await request(`${API}/operations/${operationName}`, "poll-backup");
  }
  fail("backup-timeout");
}
