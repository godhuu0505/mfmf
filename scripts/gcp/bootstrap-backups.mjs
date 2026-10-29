// Operator-only, fixed-resource bootstrap. No user records, secret values or workload executions.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { validateBackupJob as validateDeployedBackupJob, validateBackupTask } from "./deploy-backup-jobs.mjs";

export const PROJECT = "mfmf-499612";
export const PROJECT_NUMBER = "92772745697";
export const REGION = "asia-northeast1";
const IAM = "https://iam.googleapis.com/v1";
const STORAGE = "https://storage.googleapis.com/storage/v1";
const RUN = "https://run.googleapis.com/v2";
const SCHEDULER = "https://cloudscheduler.googleapis.com/v1";
const SERVICE = "https://serviceusage.googleapis.com/v1";
const RESOURCE = "https://cloudresourcemanager.googleapis.com/v1";
const PARENT = `projects/${PROJECT}/locations/${REGION}`;
const member = (id) => `serviceAccount:${id}@${PROJECT}.iam.gserviceaccount.com`;
const email = (id) => `${id}@${PROJECT}.iam.gserviceaccount.com`;
const accountName = (id) => `projects/${PROJECT}/serviceAccounts/${email(id)}`;
const roleName = (id) => `projects/${PROJECT}/roles/${id}`;
export const IDENTITY_BUCKET = `${PROJECT}-identity-backups`;
export const OPS_BUCKET = `${PROJECT}-backup-ops`;
export const RECEIPT_OBJECT = "retention/latest.json";
export const IMAGE_PREFIX = `asia-northeast1-docker.pkg.dev/${PROJECT}/mfmf/mfmf-db-operator@sha256:`;
export const ACCOUNTS = ["mfmf-identity-backup", "mfmf-db-retention", "mfmf-backup-scheduler"];
export const JOBS = ACCOUNTS.slice(0, 2);
const DEPLOYER = "mfmf-deploy";
const DB_OPERATOR = "mfmf-db-operator";
const APIS = ["iam.googleapis.com", "storage.googleapis.com", "run.googleapis.com", "cloudresourcemanager.googleapis.com", "identitytoolkit.googleapis.com", "sqladmin.googleapis.com", "cloudscheduler.googleapis.com"];
export const ROLES = [
  { id: "mfmfIdentityBackupReader", permissions: ["firebaseauth.configs.get", "firebaseauth.configs.getHashConfig", "firebaseauth.users.get"] },
  { id: "mfmfDatabaseBackupRetention", permissions: ["cloudsql.backupRuns.delete", "cloudsql.backupRuns.get", "cloudsql.backupRuns.list", "cloudsql.instances.get", "cloudsql.instances.list"] },
  { id: "mfmfBackupBucketReader", permissions: ["storage.buckets.get"] },
  { id: "mfmfBackupObjectWriter", permissions: ["storage.objects.create", "storage.objects.get"] },
  { id: "mfmfBackupReceiptWriter", permissions: ["storage.objects.create", "storage.objects.delete", "storage.objects.get"] },
  { id: "mfmfBackupReceiptReader", permissions: ["storage.objects.get"] },
  { id: "mfmfBackupJobDeployer", permissions: ["run.executions.get", "run.jobs.get", "run.jobs.run", "run.jobs.update"] },
  { id: "mfmfBackupJobInvoker", permissions: ["run.jobs.run"] },
  { id: "mfmfBackupQuotaUser", permissions: ["serviceusage.services.use"] },
];
const sorted = (v) => [...v].sort();
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const canonical = (v) => Array.isArray(v) ? v.map(canonical) : object(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const exact = (v, keys) => object(v) && same(Object.keys(v).sort(), sorted(keys));
const fail = () => { throw new Error("Backup bootstrap stopped; input, credentials and API details withheld. Inspect state before retrying."); };
const requireTrue = (value) => { if (!value) fail(); };
const digest = (v) => typeof v === "string" && v.startsWith(IMAGE_PREFIX) && /^[a-f0-9]{64}$/.test(v.slice(IMAGE_PREFIX.length));
const condition = (title, expression) => ({ title, expression });
const bucketObject = (bucket, name) => `projects/_/buckets/${bucket}/objects/${name}`;
const authCondition = condition("mfmf-identity-backups-only", `resource.name.startsWith('${bucketObject(IDENTITY_BUCKET, "identity/")}')`);
const receiptCondition = condition("mfmf-retention-receipt-only", `resource.name=='${bucketObject(OPS_BUCKET, RECEIPT_OBJECT)}'`);
const binding = (id, account, extra) => ({ role: id.startsWith("roles/") ? id : roleName(id), members: [member(account)], ...(extra ? { condition: extra } : {}) });

export function backupBucketConfig(name) {
  requireTrue([IDENTITY_BUCKET, OPS_BUCKET].includes(name));
  return {
    name, location: "ASIA-NORTHEAST1", storageClass: "STANDARD",
    iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: "enforced" },
    versioning: { enabled: false }, softDeletePolicy: { retentionDurationSeconds: "604800" },
    ...(name === IDENTITY_BUCKET ? { retentionPolicy: { retentionPeriod: "2592000" }, lifecycle: { rule: [{ action: { type: "Delete" }, condition: { age: 30, matchesPrefix: ["identity/"] } }] } } : {}),
    labels: { app: "mfmf", purpose: name === IDENTITY_BUCKET ? "identity-backups" : "backup-ops" },
  };
}
export function validateBackupBucket(actual, desired) {
  requireTrue(object(actual) && actual.name === desired.name && actual.projectNumber === PROJECT_NUMBER && actual.location === desired.location && actual.storageClass === "STANDARD"
    && actual.iamConfiguration?.uniformBucketLevelAccess?.enabled === true && actual.iamConfiguration?.publicAccessPrevention === "enforced"
    && !actual.versioning?.enabled && actual.softDeletePolicy?.retentionDurationSeconds === "604800"
    && !actual.hierarchicalNamespace?.enabled && !actual.autoclass?.enabled && !actual.encryption?.defaultKmsKeyName && !actual.defaultEventBasedHold
    && (!actual.cors || Array.isArray(actual.cors) && actual.cors.length === 0));
  if (desired.name === IDENTITY_BUCKET) requireTrue(actual.retentionPolicy?.retentionPeriod === "2592000" && actual.retentionPolicy.isLocked !== true && same(actual.lifecycle, desired.lifecycle));
  else requireTrue(!actual.retentionPolicy && (!actual.lifecycle || same(actual.lifecycle, { rule: [] })));
}
function validateAccount(actual, id) {
  requireTrue(object(actual) && actual.email === email(id) && actual.projectId === PROJECT && actual.disabled !== true && typeof actual.uniqueId === "string" && /^[0-9]+$/.test(actual.uniqueId));
}
function validateRole(actual, desired) {
  requireTrue(object(actual) && actual.name === roleName(desired.id) && actual.stage === "GA" && actual.deleted !== true && Array.isArray(actual.includedPermissions) && same(sorted(actual.includedPermissions), sorted(desired.permissions)));
}
// Append only missing bindings, preserving other principals. Any different grants for protected
// principals on this resource are configuration drift, not a request to repair permissions.
export function planPolicy(policy, wanted, protectedMembers = []) {
  requireTrue(object(policy) && typeof policy.etag === "string" && policy.etag.length > 0 && (policy.bindings === undefined || Array.isArray(policy.bindings)));
  const actual = policy.bindings ?? [];
  for (const b of actual) {
    requireTrue(object(b) && typeof b.role === "string" && Array.isArray(b.members) && b.members.every((m) => typeof m === "string") && !b.members.some((m) => ["allUsers", "allAuthenticatedUsers"].includes(m)));
    for (const m of protectedMembers) if (b.members.includes(m)) requireTrue(wanted.some((w) => w.role === b.role && same(w.condition, b.condition) && w.members.includes(m)));
  }
  const next = structuredClone(policy); next.version = 3; next.bindings ??= [];
  let changed = false;
  for (const w of wanted) {
    const matches = next.bindings.filter((b) => b.role === w.role && same(b.condition, w.condition));
    requireTrue(matches.length <= 1);
    if (matches.length) { for (const m of w.members) if (!matches[0].members.includes(m)) { matches[0].members.push(m); changed = true; } }
    else { next.bindings.push(structuredClone(w)); changed = true; }
  }
  return changed ? next : null;
}

export function validateBackupJob(job, id) {
  // Bootstrap and continuous deployment must accept exactly the same workload boundary.
  validateDeployedBackupJob(job, id);
  requireTrue(JOBS.includes(id) && object(job) && job.name === `${PARENT}/jobs/${id}` && typeof job.uid === "string" && job.uid && typeof job.etag === "string" && job.etag
    && job.reconciling !== true && !job.deleteTime && job.terminalCondition?.state === "CONDITION_SUCCEEDED"
    && (job.template?.taskCount ?? 1) === 1 && (job.template?.parallelism ?? 1) === 1);
  const task = job.template?.template;
  requireTrue(object(task) && task.serviceAccount === email(id) && (task.maxRetries ?? 0) === 0 && task.timeout === "900s"
    && (!task.vpcAccess || same(task.vpcAccess, {})) && (!task.volumes || task.volumes.length === 0)
    && (!task.executionEnvironment || task.executionEnvironment === "EXECUTION_ENVIRONMENT_GEN2") && Array.isArray(task.containers) && task.containers.length === 1);
  const container = task.containers[0];
  requireTrue(object(container) && digest(container.image) && same(container.command, ["node", "/app/scripts/gcp/run-backup-job.mjs"])
    && same(container.args, ["--execute"]) && same(container.resources?.limits, { cpu: "1", memory: "512Mi" })
    && (!container.volumeMounts || container.volumeMounts.length === 0) && (!container.ports || container.ports.length === 0)
    && Array.isArray(container.env) && container.env.length === 1 && exact(container.env[0], ["name", "value"])
    && container.env[0].name === "MFMF_BACKUP_DEPLOY_SHA" && /^[a-f0-9]{40}$/.test(container.env[0].value));
  return { image: container.image, sha: container.env[0].value, uid: job.uid };
}
export function schedulerConfig(id) {
  requireTrue(JOBS.includes(id));
  return { name: `${PARENT}/jobs/${id}`, schedule: id === JOBS[0] ? "17 4 * * *" : "47 4 * * *", timeZone: "Asia/Tokyo",
    attemptDeadline: "180s", retryConfig: { retryCount: 0 },
    httpTarget: { uri: `${RUN}/${PARENT}/jobs/${id}:run`, httpMethod: "POST", body: Buffer.from("{}").toString("base64"),
      headers: { "Content-Type": "application/json" }, oauthToken: { serviceAccountEmail: email(ACCOUNTS[2]), scope: "https://www.googleapis.com/auth/cloud-platform" } } };
}
export function validateScheduler(actual, desired) {
  requireTrue(object(actual) && actual.name === desired.name && actual.state === "ENABLED" && actual.schedule === desired.schedule && actual.timeZone === desired.timeZone && actual.attemptDeadline === desired.attemptDeadline
    && (actual.retryConfig?.retryCount ?? 0) === 0 && (actual.retryConfig?.maxRetryDuration ?? "0s") === "0s" && !actual.pubsubTarget && !actual.appEngineHttpTarget);
  const t = actual.httpTarget;
  requireTrue(object(t) && t.uri === desired.httpTarget.uri && t.httpMethod === "POST" && t.body === desired.httpTarget.body && !t.oidcToken && same(t.oauthToken, desired.httpTarget.oauthToken));
  const headers = Object.fromEntries(Object.entries(t.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  requireTrue(headers["content-type"] === "application/json" && Object.keys(headers).every((k) => ["content-type", "user-agent"].includes(k)));
}
export function validateExecution(execution, job, id, now = Date.now()) {
  const current = validateBackupJob(job, id);
  const name = execution?.name;
  requireTrue(typeof name === "string" && name.startsWith(`${PARENT}/jobs/${id}/executions/${id}-`) && /^[a-z0-9-]+$/.test(name.split("/").at(-1))
    && typeof execution.uid === "string" && execution.uid && [job.name, id].includes(execution.job) && execution.reconciling !== true
    && execution.taskCount === 1 && execution.parallelism === 1 && execution.succeededCount === 1 && !execution.deleteTime
    && (execution.failedCount ?? 0) === 0 && (execution.cancelledCount ?? 0) === 0 && (execution.retriedCount ?? 0) === 0 && (execution.runningCount ?? 0) === 0
    && Array.isArray(execution.conditions) && execution.conditions.some((c) => c.type === "Completed" && c.state === "CONDITION_SUCCEEDED"));
  const completed = Date.parse(execution.completionTime); const start = Date.parse(execution.startTime);
  requireTrue(Number.isFinite(start) && Number.isFinite(completed) && completed >= start && completed <= now + 60_000 && now - completed <= 24 * 3600_000);
  // Check semantic configuration, including API-default omissions, with the continuous validator.
  validateBackupTask(execution.template, id, current.image, current.sha);
  return current;
}
export function validateLegacyExecution(legacy, execution) {
  requireTrue(legacy?.kind === "Execution" && legacy.metadata?.uid === execution.uid && legacy.metadata.name === execution.name.split("/").at(-1)
    && [PROJECT, PROJECT_NUMBER].includes(legacy.metadata.namespace) && !legacy.metadata.deletionTimestamp);
  for (const annotations of [legacy.metadata.annotations, legacy.spec?.template?.metadata?.annotations]) {
    requireTrue(annotations === undefined || object(annotations));
    for (const key of ["run.googleapis.com/network-interfaces", "run.googleapis.com/vpc-access-connector", "run.googleapis.com/vpc-access-egress"]) requireTrue(annotations?.[key] === undefined);
  }
}
const schedulerAgentReady = (policy) => policy.bindings?.some((b) => b.role === "roles/cloudscheduler.serviceAgent" && !b.condition
  && b.members?.includes(`serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-cloudscheduler.iam.gserviceaccount.com`)) === true;

export function backupPlan() {
  return { project: PROJECT, buckets: [IDENTITY_BUCKET, OPS_BUCKET], accounts: ACCOUNTS, jobs: JOBS, phaseOrder: ["prepare", "bind-jobs", "schedule"],
    schedulesJst: ["04:17", "04:47"], identityRetentionDays: 30, softDeleteDays: 7, receiptObject: RECEIPT_OBJECT,
    schedulerRequiresRecentSuccessfulExecutions: true, serviceAccountKeysCreated: false, workloadExecutionsStarted: false };
}

export async function bootstrapBackups({ token, phase = "inspect", executions = {}, fetchImpl = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now, log = console.log }) {
  requireTrue(["inspect", "prepare", "bind-jobs", "schedule"].includes(phase) && typeof token === "string" && token.length > 0 && token.length <= 16384 && !/[\r\n]/.test(token));
  const request = async (url, { method = "GET", body, missing = false } = {}) => {
    let response;
    try { response = await fetchImpl(url, { method, headers: { Authorization: `Bearer ${token}`, "X-Goog-User-Project": PROJECT, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: "error", signal: AbortSignal.timeout(30_000) }); } catch { fail(); }
    if (missing && response.status === 404) { try { await response.body?.cancel(); } catch { /* no body output */ } return null; }
    if (!response.ok) { try { await response.body?.cancel(); } catch { /* no body output */ } log(`Backup bootstrap API stopped: ${method} HTTP ${response.status}. Details withheld.`); fail(); }
    try { let size = 0; const parts = []; for await (const part of response.body) { size += part.length; if (size > 1024 * 1024) fail(); parts.push(Buffer.from(part)); } return JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { fail(); }
  };
  const projectPolicy = () => request(`${RESOURCE}/projects/${PROJECT}:getIamPolicy`, { method: "POST", body: { options: { requestedPolicyVersion: 3 } } });
  const saPolicy = (id) => request(`${IAM}/${accountName(id)}:getIamPolicy`, { method: "POST", body: { options: { requestedPolicyVersion: 3 } } });
  const bucketPolicy = (name) => request(`${STORAGE}/b/${name}/iam?optionsRequestedPolicyVersion=3`);
  const jobPolicy = (id) => request(`${RUN}/${PARENT}/jobs/${id}:getIamPolicy?options.requestedPolicyVersion=3`);
  const projectWanted = [binding(ROLES[0].id, ACCOUNTS[0]), binding(ROLES[1].id, ACCOUNTS[1]),
    ...[...JOBS, DB_OPERATOR, DEPLOYER].map((id) => binding("mfmfBackupQuotaUser", id))];
  const bucketWanted = (name) => name === IDENTITY_BUCKET
    ? [binding("mfmfBackupBucketReader", ACCOUNTS[0]), binding("mfmfBackupObjectWriter", ACCOUNTS[0], authCondition)]
    : [binding("mfmfBackupBucketReader", ACCOUNTS[1]), binding("mfmfBackupReceiptWriter", ACCOUNTS[1], receiptCondition), binding("mfmfBackupBucketReader", DB_OPERATOR), binding("mfmfBackupReceiptReader", DB_OPERATOR, receiptCondition)];
  const jobWanted = [binding("mfmfBackupJobDeployer", DEPLOYER), binding("mfmfBackupJobInvoker", ACCOUNTS[2])];
  const accounts = new Map(); const roles = new Map(); const buckets = new Map(); const jobs = new Map(); const schedules = new Map();
  let schedulerDisabled = false;
  for (const api of APIS) {
    const state = await request(`${SERVICE}/projects/${PROJECT_NUMBER}/services/${api}?fields=name,state`);
    requireTrue(state?.name === `projects/${PROJECT_NUMBER}/services/${api}`);
    if (state.state !== "ENABLED") { requireTrue(api === "cloudscheduler.googleapis.com" && state.state === "DISABLED" && ["inspect", "prepare"].includes(phase)); schedulerDisabled = true; }
  }
  for (const id of ACCOUNTS) {
    const actual = await request(`${IAM}/${accountName(id)}`, { missing: true }); accounts.set(id, actual);
    if (actual) {
      validateAccount(actual, id);
      const keys = await request(`${IAM}/${accountName(id)}/keys?keyTypes=USER_MANAGED`); requireTrue(!keys.keys || Array.isArray(keys.keys) && keys.keys.length === 0);
      const wanted = JOBS.includes(id) ? [binding("roles/iam.serviceAccountUser", DEPLOYER)] : [];
      // Dedicated identities must not have an existing impersonator, key or unreviewed policy.
      const policy = await saPolicy(id); requireTrue((policy.bindings ?? []).every((b) => wanted.some((w) => same(w, b)))); planPolicy(policy, wanted);
    }
  }
  for (const role of ROLES) { const actual = await request(`${IAM}/${roleName(role.id)}`, { missing: true }); roles.set(role.id, actual); if (actual) validateRole(actual, role); }
  const projectBefore = await projectPolicy(); planPolicy(projectBefore, projectWanted, ACCOUNTS.map(member));
  for (const name of [IDENTITY_BUCKET, OPS_BUCKET]) {
    const actual = await request(`${STORAGE}/b/${name}`, { missing: true }); buckets.set(name, actual);
    if (actual) { validateBackupBucket(actual, backupBucketConfig(name)); planPolicy(await bucketPolicy(name), bucketWanted(name), [...ACCOUNTS, DB_OPERATOR].map(member)); }
  }
  // Inspect existing jobs and schedules even in prepare: collisions are rejected before writes.
  for (const id of JOBS) {
    const actual = await request(`${RUN}/${PARENT}/jobs/${id}`, { missing: true }); jobs.set(id, actual);
    if (actual) { validateBackupJob(actual, id); planPolicy(await jobPolicy(id), jobWanted, [DEPLOYER, ACCOUNTS[2]].map(member)); }
    const schedule = schedulerDisabled ? null : await request(`${SCHEDULER}/${PARENT}/jobs/${id}`, { missing: true }); schedules.set(id, schedule);
    if (schedule) validateScheduler(schedule, schedulerConfig(id));
  }
  if (phase === "inspect") { log(JSON.stringify({ ...backupPlan(), phase, schedulerEnabled: !schedulerDisabled, schedulerServiceAgentReady: schedulerAgentReady(projectBefore), existingAccounts: [...accounts.values()].filter(Boolean).length, existingBuckets: [...buckets.values()].filter(Boolean).length, existingJobs: [...jobs.values()].filter(Boolean).length, existingSchedules: [...schedules.values()].filter(Boolean).length })); return; }
  if (phase !== "prepare") requireTrue([...accounts.values(), ...roles.values(), ...buckets.values(), ...jobs.values()].every(Boolean) && !schedulerDisabled);
  if (phase === "schedule") {
    requireTrue(exact(executions, JOBS));
    let first;
    for (const id of JOBS) {
      const e = executions[id]; requireTrue(typeof e === "string" && new RegExp(`^${id}-[a-z0-9-]+$`).test(e) && e.length < 128);
      const execution = await request(`${RUN}/${PARENT}/jobs/${id}/executions/${e}`);
      const proof = validateExecution(execution, jobs.get(id), id, now());
      validateLegacyExecution(await request(`https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT}/executions/${e}`), execution);
      if (first) requireTrue(same(proof.image, first.image) && proof.sha === first.sha); else first = proof;
      requireTrue(planPolicy(await jobPolicy(id), jobWanted, [DEPLOYER, ACCOUNTS[2]].map(member)) === null);
    }
  }
  if (phase === "prepare") {
    if (schedulerDisabled) {
      let operation = await request(`${SERVICE}/projects/${PROJECT_NUMBER}/services/cloudscheduler.googleapis.com:enable`, { method: "POST", body: {} });
      // Service Usage returns dotted operation identifiers (observed acf.*), not
      // Cloud Run's operation format. Permit safe dot-separated segments only.
      requireTrue(typeof operation?.name === "string" && /^operations\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(operation.name) && operation.name.length <= 256); const name = operation.name;
      for (let i = 0; operation.done !== true && i < 30; i++) { await sleep(1000); operation = await request(`${SERVICE}/${name}`); requireTrue(operation.name === name && !operation.error); }
      requireTrue(operation.done === true && !operation.error);
    }
    for (const id of ACCOUNTS) if (!accounts.get(id)) validateAccount(await request(`${IAM}/projects/${PROJECT}/serviceAccounts`, { method: "POST", body: { accountId: id, serviceAccount: { displayName: id } } }), id);
    for (const role of ROLES) if (!roles.get(role.id)) validateRole(await request(`${IAM}/projects/${PROJECT}/roles`, { method: "POST", body: { roleId: role.id, role: { title: role.id, stage: "GA", includedPermissions: role.permissions } } }), role);
    for (const name of [IDENTITY_BUCKET, OPS_BUCKET]) if (!buckets.get(name)) validateBackupBucket(await request(`${STORAGE}/b?project=${PROJECT}`, { method: "POST", body: backupBucketConfig(name) }), backupBucketConfig(name));
    const projectNext = planPolicy(await projectPolicy(), projectWanted, ACCOUNTS.map(member));
    if (projectNext) await request(`${RESOURCE}/projects/${PROJECT}:setIamPolicy`, { method: "POST", body: { policy: projectNext } });
    for (const id of JOBS) { const next = planPolicy(await saPolicy(id), [binding("roles/iam.serviceAccountUser", DEPLOYER)]); if (next) await request(`${IAM}/${accountName(id)}:setIamPolicy`, { method: "POST", body: { policy: next } }); }
    for (const name of [IDENTITY_BUCKET, OPS_BUCKET]) { const next = planPolicy(await bucketPolicy(name), bucketWanted(name), [...ACCOUNTS, DB_OPERATOR].map(member)); if (next) await request(`${STORAGE}/b/${name}/iam`, { method: "PUT", body: next }); }
  } else if (phase === "bind-jobs") {
    for (const id of JOBS) { const next = planPolicy(await jobPolicy(id), jobWanted, [DEPLOYER, ACCOUNTS[2]].map(member)); if (next) await request(`${RUN}/${PARENT}/jobs/${id}:setIamPolicy`, { method: "POST", body: { policy: next } }); }
  } else {
    // Creating a Scheduler immediately enables it. This phase is allowed only after both actual jobs succeeded.
    const p = await projectPolicy();
    // If enabling the API did not provision this standard service agent, an operator
    // must generate the service identity and its standard binding before this phase.
    // Never create the first active schedule to trigger IAM provisioning as a side effect.
    requireTrue(schedulerAgentReady(p));
    for (const id of JOBS) if (!schedules.get(id)) validateScheduler(await request(`${SCHEDULER}/${PARENT}/jobs`, { method: "POST", body: schedulerConfig(id) }), schedulerConfig(id));
  }
  // Re-read exact resources and bindings. No automatic retries of failed mutations or drift repair.
  for (const role of ROLES) validateRole(await request(`${IAM}/${roleName(role.id)}`), role);
  for (const id of ACCOUNTS) validateAccount(await request(`${IAM}/${accountName(id)}`), id);
  requireTrue(planPolicy(await projectPolicy(), projectWanted, ACCOUNTS.map(member)) === null);
  for (const id of JOBS) requireTrue(planPolicy(await saPolicy(id), [binding("roles/iam.serviceAccountUser", DEPLOYER)]) === null);
  for (const name of [IDENTITY_BUCKET, OPS_BUCKET]) { validateBackupBucket(await request(`${STORAGE}/b/${name}`), backupBucketConfig(name)); requireTrue(planPolicy(await bucketPolicy(name), bucketWanted(name), [...ACCOUNTS, DB_OPERATOR].map(member)) === null); }
  if (phase !== "prepare") for (const id of JOBS) { const latest = await request(`${RUN}/${PARENT}/jobs/${id}`); requireTrue(latest.uid === jobs.get(id).uid && latest.etag === jobs.get(id).etag); validateBackupJob(latest, id); requireTrue(planPolicy(await jobPolicy(id), jobWanted, [DEPLOYER, ACCOUNTS[2]].map(member)) === null); }
  if (phase === "schedule") for (const id of JOBS) validateScheduler(await request(`${SCHEDULER}/${PARENT}/jobs/${id}`), schedulerConfig(id));
  log(JSON.stringify({ phase, verified: true, credentialsPrinted: false, serviceAccountKeysCreated: false, workloadExecutionsStarted: false, schedulesEnabled: phase === "schedule", schedulerServiceAgentReady: schedulerAgentReady(await projectPolicy()) }));
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || same(args, ["--plan"])) { console.log(JSON.stringify(backupPlan())); return; }
  const phases = { "--inspect": "inspect", "--apply-prepare": "prepare", "--apply-bind-jobs": "bind-jobs", "--apply-schedule": "schedule" };
  const phase = phases[args[0]]; requireTrue(!!phase);
  const executions = {};
  for (const arg of args.slice(1)) { const match = /^--execution-(identity|retention)=([a-z0-9-]+)$/.exec(arg); requireTrue(phase === "schedule" && !!match); const id = JOBS[match[1] === "identity" ? 0 : 1]; requireTrue(!executions[id]); executions[id] = match[2]; }
  if (phase === "schedule") requireTrue(exact(executions, JOBS));
  let token;
  try { token = (await promisify(execFile)("/Users/godai.tanaka/.local/share/mfmf-tools/google-cloud-sdk/bin/gcloud", ["auth", "print-access-token", "--quiet"], { encoding: "utf8", maxBuffer: 16384,
    env: { HOME: "/Users/godai.tanaka", PATH: "/usr/bin:/bin", CLOUDSDK_PYTHON: "/Users/godai.tanaka/.pyenv/versions/3.13.2/bin/python3" } })).stdout.trim(); } catch { fail(); }
  await bootstrapBackups({ token, phase, executions });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { console.error("Backup bootstrap failed; credentials, input and API details withheld. Inspect before retrying."); process.exitCode = 1; });
