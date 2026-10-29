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
  const verify = (backup, expectedName, replacedBytes = 0n, createdAfter) => {
    const expiry = Date.parse(backup?.expiryTime);
    const started = Date.parse(backup?.backupInterval?.startTime);
    const ended = Date.parse(backup?.backupInterval?.endTime);
    if (!backupName(backup?.name) || backup.name !== expectedName || backup.instance !== INSTANCE || backup.description !== description
      || backup.type !== "ON_DEMAND" || backup.state !== "SUCCESSFUL" || backup.location !== "asia-northeast1"
      || !Number.isFinite(expiry) || expiry < now() + DAY || expiry > now() + 14 * DAY + 60_000
      // startTime, not completion, bounds the writes guaranteed to be included.
      || !Number.isFinite(started) || started < now() - 15 * 60_000 || started > now() + 30_000
      || !Number.isFinite(ended) || ended < started || ended > now() + 30_000
      || (createdAfter !== undefined && started < createdAfter - 30_000)
      || backup.error) fail("verify-backup");
    if (onDemandBytes - replacedBytes + chargeableBytes(backup) > MAX_ON_DEMAND_BYTES) fail("backup-capacity");
    return { verified: true, retentionDaysMaximum: 14 };
  };
  // A lost create response must not produce one indefinite duplicate per retry.
  // Listing requires completeness, and a previous pending/failed/missing-TTL
  // marker stops for operator inspection instead of silently creating another.
  let pageToken; const matches = []; const seenTokens = new Set(); const seenBackups = new Set();
  for (let page = 0; page < 10; page++) {
    const url = new URL(`${API}/backups`);
    url.searchParams.set("filter", `instance:${INSTANCE}`);
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const result = await request(url.toString(), "list-backups");
    if (!result || !Array.isArray(result.backups ?? []) || result.warnings?.length) fail("list-backups");
    for (const backup of result.backups ?? []) {
      if (!backupName(backup?.name) || backup.instance !== INSTANCE || seenBackups.has(backup.name)
        || !["ON_DEMAND", "AUTOMATED", "FINAL"].includes(backup.type)) fail("list-backups");
      seenBackups.add(backup.name);
      if (backup.type === "ON_DEMAND") {
        onDemandCount++; onDemandBytes += chargeableBytes(backup);
      }
      if (backup.description === description) matches.push(backup);
    }
    if (!result.nextPageToken) { pageToken = undefined; break; }
    if (typeof result.nextPageToken !== "string" || result.nextPageToken.length > 4096 || seenTokens.has(result.nextPageToken)) fail("list-backups");
    pageToken = result.nextPageToken; seenTokens.add(pageToken);
  }
  if (pageToken || matches.length > 1) fail("list-backups");
  if (onDemandCount > MAX_ON_DEMAND_COUNT || onDemandBytes > MAX_ON_DEMAND_BYTES) fail("backup-capacity");
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
