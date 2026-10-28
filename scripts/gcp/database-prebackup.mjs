// Called only while the database advisory transaction lock is held, and only
// when the checksum ledger reports pending SQL. Never reads database contents.
const PROJECT = "mfmf-499612";
const INSTANCE = "mfmf-db";
const API = `https://sqladmin.googleapis.com/v1/projects/${PROJECT}`;
const DAY = 86_400_000;
const fail = (stage, status) => { throw new Error(`Database prebackup failed: stage=${stage}${status ? ` http=${status}` : ""}; details withheld.`); };
const backupName = (value) => typeof value === "string" && /^projects\/mfmf-499612\/backups\/[A-Za-z0-9_-]{1,200}$/.test(value);

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
  const verify = (backup, createdAfter) => {
    const expiry = Date.parse(backup?.expiryTime);
    const ended = Date.parse(backup?.backupInterval?.endTime);
    if (!backupName(backup?.name) || backup.instance !== INSTANCE || backup.description !== description
      || backup.type !== "ON_DEMAND" || backup.state !== "SUCCESSFUL" || backup.location !== "asia-northeast1"
      || !Number.isFinite(expiry) || expiry < now() + DAY || expiry > now() + 14 * DAY + 60_000
      || !Number.isFinite(ended) || ended > now() + 30_000 || ended < now() - 15 * 60_000
      || (createdAfter !== undefined && ended < createdAfter - 30_000)
      || backup.error) fail("verify-backup");
    return { verified: true, retentionDaysMaximum: 14 };
  };
  // A lost create response must not produce one indefinite duplicate per retry.
  // Listing requires completeness, and a previous pending/failed/missing-TTL
  // marker stops for operator inspection instead of silently creating another.
  let pageToken; const matches = []; const seenTokens = new Set();
  for (let page = 0; page < 10; page++) {
    const url = new URL(`${API}/backups`);
    url.searchParams.set("filter", `instance:${INSTANCE}`);
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const result = await request(url.toString(), "list-backups");
    if (!result || !Array.isArray(result.backups ?? []) || result.warnings?.length) fail("list-backups");
    for (const backup of result.backups ?? []) if (backup.description === description) matches.push(backup);
    if (!result.nextPageToken) { pageToken = undefined; break; }
    if (typeof result.nextPageToken !== "string" || result.nextPageToken.length > 4096 || seenTokens.has(result.nextPageToken)) fail("list-backups");
    pageToken = result.nextPageToken; seenTokens.add(pageToken);
  }
  if (pageToken || matches.length > 1) fail("list-backups");
  if (matches.length === 1) {
    if (!backupName(matches[0].name)) fail("verify-backup");
    return verify(await request(`https://sqladmin.googleapis.com/v1/${matches[0].name}`, "get-backup"));
  }
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
      return verify(await request(`https://sqladmin.googleapis.com/v1/${operation.backupContext.name}`, "get-backup"), createdAfter);
    }
    await wait(5_000);
    operation = await request(`${API}/operations/${operationName}`, "poll-backup");
  }
  fail("backup-timeout");
}
