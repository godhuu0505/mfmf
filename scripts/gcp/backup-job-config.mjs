export const BACKUP_PROJECT = "mfmf-499612";
export const BACKUP_NUMBER = "92772745697";
export const BACKUP_REGION = "asia-northeast1";
export const IDENTITY_BUCKET = `${BACKUP_PROJECT}-identity-backups`;
export const BACKUP_JOBS = Object.freeze(["mfmf-identity-backup", "mfmf-db-retention"]);
export const BACKUP_IMAGE = `${BACKUP_REGION}-docker.pkg.dev/${BACKUP_PROJECT}/mfmf/mfmf-db-operator`;
const details = new WeakMap();
const STAGES = new Set(["context", "metadata", "bucket", "encrypt", "archive", "upload", "readback", "receipt", "retention", "job", "execution", "operation", "update", "run", "unexpected"]);
export class BackupJobError extends Error {
  constructor(stage, status) { super("Backup operation stopped; details withheld."); details.set(this, {
    status: "failed", component: "backup", stage: STAGES.has(stage) ? stage : "unexpected",
    ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { httpStatus: status } : {}),
  }); }
}
export const backupJobDiagnostic = (e) => details.get(e) ? { ...details.get(e) } : null;
export const requireBackup = (v, stage) => { if (!v) throw new BackupJobError(stage); };
export function backupJobName(job) { requireBackup(BACKUP_JOBS.includes(job), "context"); return `projects/${BACKUP_PROJECT}/locations/${BACKUP_REGION}/jobs/${job}`; }
export const backupAccount = (job) => { backupJobName(job); return `${job}@${BACKUP_PROJECT}.iam.gserviceaccount.com`; };
export const backupDigest = (image) => typeof image === "string" && image.startsWith(`${BACKUP_IMAGE}@sha256:`) && /^[a-f0-9]{64}$/.test(image.slice(`${BACKUP_IMAGE}@sha256:`.length));
export function backupContext(env) {
  requireBackup(BACKUP_JOBS.includes(env.CLOUD_RUN_JOB) && env.CLOUD_RUN_TASK_COUNT === "1" && env.CLOUD_RUN_TASK_INDEX === "0"
    && env.CLOUD_RUN_TASK_ATTEMPT === "0" && /^[a-f0-9]{40}$/.test(env.MFMF_BACKUP_DEPLOY_SHA ?? "")
    && new RegExp(`^${env.CLOUD_RUN_JOB}-[a-z0-9]{5,20}$`).test(env.CLOUD_RUN_EXECUTION ?? "")
    && !env.GCP_ACCESS_TOKEN && !env.GOOGLE_APPLICATION_CREDENTIALS, "context");
  return { job: env.CLOUD_RUN_JOB, execution: env.CLOUD_RUN_EXECUTION, sourceCommit: env.MFMF_BACKUP_DEPLOY_SHA };
}
export async function responseBytes(response, stage, limit = 1_048_576) {
  try { const parts = []; let length = 0;
    for await (const part of response.body) { length += part.length; requireBackup(length <= limit, stage); parts.push(Buffer.from(part)); }
    return Buffer.concat(parts);
  } catch { throw new BackupJobError(stage); }
}
export async function backupToken(env, fetchImpl = fetch) {
  const { job } = backupContext(env);
  const metadata = async (path) => {
    let response;
    try { response = await fetchImpl(`http://metadata.google.internal/computeMetadata/v1/${path}`, {
      method: "GET", headers: { "Metadata-Flavor": "Google" }, redirect: "error", signal: AbortSignal.timeout(5000),
    }); } catch { throw new BackupJobError("metadata"); }
    if (!response.ok || response.headers.get("metadata-flavor") !== "Google") {
      try { await response.body?.cancel(); } catch { /* No metadata body or exception details. */ }
      throw new BackupJobError("metadata", response.status);
    }
    try { return new TextDecoder("utf-8", { fatal: true }).decode(await responseBytes(response, "metadata", 32768)); }
    catch { throw new BackupJobError("metadata"); }
  };
  requireBackup(await metadata("project/project-id") === BACKUP_PROJECT && await metadata("project/numeric-project-id") === BACKUP_NUMBER
    && await metadata("instance/service-accounts/default/email") === backupAccount(job), "metadata");
  let token;
  try { token = JSON.parse(await metadata("instance/service-accounts/default/token")); } catch { throw new BackupJobError("metadata"); }
  requireBackup(token?.token_type === "Bearer" && typeof token.access_token === "string" && token.access_token.length > 0
    && token.access_token.length <= 16384 && !/[\s\x00-\x1f\x7f-\uffff]/.test(token.access_token)
    && Number.isInteger(token.expires_in) && token.expires_in >= 900 && token.expires_in <= 3600, "metadata");
  return token.access_token;
}
