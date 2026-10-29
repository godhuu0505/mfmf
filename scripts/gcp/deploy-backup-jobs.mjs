// Update only the two provisioned jobs. No create, IAM, scheduler or SQL calls.
import { requireContinuousContext } from "./production-config.mjs";
import { BACKUP_JOBS, BACKUP_PROJECT, BACKUP_NUMBER, BACKUP_REGION, backupJobName, backupAccount,
  backupDigest, BackupJobError, requireBackup as need, responseBytes } from "./backup-job-config.mjs";
const ROOT = "https://run.googleapis.com/v2/";
const exact = (v, keys) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
export function validateBackupTask(task, job, image, sha) {
  need(task?.serviceAccount === backupAccount(job) && (task.maxRetries ?? 0) === 0 && task.timeout === "900s"
    && task.executionEnvironment === "EXECUTION_ENVIRONMENT_GEN2" && !task.vpcAccess && !task.volumes?.length
    && !task.encryptionKey && !task.sandboxes?.length && !task.nodeSelector && !task.workloadIdentityConfig
    && Array.isArray(task.containers) && task.containers.length === 1, "job");
  const c = task.containers[0];
  need(backupDigest(c.image) && (!image || c.image === image) && JSON.stringify(c.command) === '["node","/app/scripts/gcp/run-backup-job.mjs"]'
    && JSON.stringify(c.args) === '["--execute"]' && !c.ports?.length && !c.volumeMounts?.length && !c.sourceCode && !c.baseImageUri
    && exact(c.resources?.limits, ["cpu", "memory"]) && c.resources.limits.cpu === "1" && c.resources.limits.memory === "512Mi"
    && c.resources.cpuIdle !== true && c.resources.startupCpuBoost !== true && Array.isArray(c.env) && c.env.length === 1
    && exact(c.env[0], ["name", "value"]) && c.env[0].name === "MFMF_BACKUP_DEPLOY_SHA" && /^[a-f0-9]{40}$/.test(c.env[0].value ?? "")
    && (!sha || c.env[0].value === sha), "job");
}
export function validateBackupJob(value, job, image, sha) {
  need(value?.name === backupJobName(job) && typeof value.uid === "string" && value.uid.length > 0 && value.uid.length < 129
    && typeof value.etag === "string" && value.etag.length > 0 && value.etag.length < 257 && !value.deleteTime && value.reconciling !== true
    && value.generation === value.observedGeneration && value.terminalCondition?.state === "CONDITION_SUCCEEDED"
    && value.template?.taskCount === 1 && value.template?.parallelism === 1 && value.template.delayExecution !== true
    && !value.startExecutionToken && !value.runExecutionToken, "job");
  validateBackupTask(value.template.template, job, image, sha); return value;
}
export function backupExecutionName(value, job) {
  const parent = backupJobName(job);
  if (typeof value !== "string") return null;
  const normalized = value.replace(`projects/${BACKUP_NUMBER}/`, `projects/${BACKUP_PROJECT}/`);
  if (new RegExp(`^${job}-[a-z0-9]{5,20}$`).test(normalized)) return `${parent}/executions/${normalized}`;
  return new RegExp(`^${parent}/executions/${job}-[a-z0-9]{5,20}$`).test(normalized) ? normalized : null;
}
export async function deployBackupJobs({ env, image, fetchImpl = fetch, wait = (ms) => new Promise((r) => setTimeout(r, ms)), maxPolls = 240 }) {
  try { requireContinuousContext(env); } catch { throw new BackupJobError("context"); }
  need(env.GCP_AUTH_ENABLED === "true" && backupDigest(image) && typeof env.GCP_ACCESS_TOKEN === "string"
    && env.GCP_ACCESS_TOKEN.length > 0 && !/[\s\x00-\x1f]/.test(env.GCP_ACCESS_TOKEN), "context");
  const api = async (url, stage, method = "GET", body) => {
    let response;
    try { response = await fetchImpl(url, { method, redirect: "error", signal: AbortSignal.timeout(30000), headers: {
      Authorization: `Bearer ${env.GCP_ACCESS_TOKEN}`, "X-Goog-User-Project": BACKUP_PROJECT, ...(body ? { "Content-Type": "application/json" } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}) }); } catch { throw new BackupJobError(stage); }
    if (!response.ok) { await response.body?.cancel(); throw new BackupJobError(stage, response.status); }
    try { return JSON.parse((await responseBytes(response, stage)).toString("utf8")); } catch { throw new BackupJobError(stage); }
  };
  const operation = async (initial) => {
    let value = initial, name;
    for (let p = 0; p < maxPolls; p++) {
      const normalized = typeof value?.name === "string" ? value.name.replace(`projects/${BACKUP_NUMBER}/`, `projects/${BACKUP_PROJECT}/`) : "";
      need(new RegExp(`^projects/${BACKUP_PROJECT}/locations/${BACKUP_REGION}/operations/[A-Za-z0-9_-]+$`).test(normalized)
        && (!name || name === normalized) && !value.error, "operation"); name = normalized;
      if (value.done === true) { need(value.response, "operation"); return value.response; }
      await wait(5000); value = await api(`${ROOT}${name}`, "operation");
    } throw new BackupJobError("operation");
  };
  const execution = async (value, job, expectedName, expectedUid) => {
    const name = backupExecutionName(value?.name, job);
    need(name && (!expectedName || name === expectedName) && (!expectedUid || value.uid === expectedUid)
      && [job, backupJobName(job), backupJobName(job).replace(BACKUP_PROJECT, BACKUP_NUMBER)].includes(value.job)
      && typeof value.uid === "string" && value.uid.length > 0 && !value.deleteTime && value.taskCount === 1 && value.parallelism === 1, "execution");
    validateBackupTask(value.template, job, image, env.GITHUB_SHA);
    // v2 may omit networking. Verify absence in the immutable v1 execution too.
    const legacy = await api(`https://${BACKUP_REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${BACKUP_PROJECT}/executions/${name.split("/").pop()}`, "execution");
    need(legacy?.kind === "Execution" && legacy.metadata?.uid === value.uid && legacy.metadata.name === name.split("/").pop()
      && [BACKUP_PROJECT, BACKUP_NUMBER].includes(legacy.metadata.namespace) && !legacy.metadata.deletionTimestamp, "execution");
    for (const annotations of [legacy.metadata.annotations, legacy.spec?.template?.metadata?.annotations]) {
      need(annotations === undefined || annotations && typeof annotations === "object" && !Array.isArray(annotations), "execution");
      for (const key of ["run.googleapis.com/network-interfaces", "run.googleapis.com/vpc-access-connector", "run.googleapis.com/vpc-access-egress"]) need(annotations?.[key] === undefined, "execution");
    }
    return name;
  };
  // Check both before any update. No missing job may be silently created.
  const initials = new Map();
  for (const job of BACKUP_JOBS) {
    const value = validateBackupJob(await api(`${ROOT}${backupJobName(job)}`, "job"), job);
    if (value.latestCreatedExecution?.name) {
      const name = backupExecutionName(value.latestCreatedExecution.name, job); need(name, "execution");
      const prior = await api(`${ROOT}${name}`, "execution");
      need(backupExecutionName(prior.name, job) === name && prior.completionTime && (prior.runningCount ?? 0) === 0, "execution");
    } initials.set(job, value);
  }
  const proofs = [];
  for (const job of BACKUP_JOBS) {
    const url = `${ROOT}${backupJobName(job)}`, initial = initials.get(job);
    const before = validateBackupJob(await api(url, "job"), job);
    need(before.uid === initial.uid && before.etag === initial.etag, "job");
    const template = structuredClone(before.template);
    template.template.containers[0].image = image;
    template.template.containers[0].env[0].value = env.GITHUB_SHA;
    const updated = validateBackupJob(await operation(await api(`${url}?allowMissing=false`, "update", "PATCH", {
      name: backupJobName(job), etag: before.etag, template,
    })), job, image, env.GITHUB_SHA);
    need(updated.uid === before.uid, "job");
    const ready = validateBackupJob(await api(url, "job"), job, image, env.GITHUB_SHA);
    need(ready.uid === before.uid && ready.etag === updated.etag, "job");
    const ran = await operation(await api(`${url}:run`, "run", "POST", { etag: ready.etag }));
    const name = await execution(ran, job);
    const finished = await api(`${ROOT}${name}`, "execution"); await execution(finished, job, name, ran.uid);
    need(finished.completionTime && finished.reconciling !== true && finished.succeededCount === 1
      && ["failedCount", "cancelledCount", "runningCount", "retriedCount"].every((k) => (finished[k] ?? 0) === 0)
      && finished.conditions?.some((c) => c.type === "Completed" && c.state === "CONDITION_SUCCEEDED"), "execution");
    const final = validateBackupJob(await api(url, "job"), job, image, env.GITHUB_SHA);
    need(final.uid === initial.uid && backupExecutionName(final.latestCreatedExecution?.name, job) === name, "job");
    proofs.push({ job, execution: name, verified: true });
  }
  return { backupsVerified: true, jobs: proofs };
}
