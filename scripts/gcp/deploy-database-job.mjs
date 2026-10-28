import { PROJECT, PROJECT_NUMBER, REGION, requireContinuousContext } from "./production-config.mjs";
import { isDatabaseVpc } from "./database-deployment-config.mjs";

export const OPERATOR_IMAGE = `asia-northeast1-docker.pkg.dev/${PROJECT}/mfmf/mfmf-db-operator`;
export const OPERATOR_JOB = `projects/${PROJECT}/locations/${REGION}/jobs/mfmf-db-operator`;
const API = `https://run.googleapis.com/v2/${OPERATOR_JOB}`;
const SA = `mfmf-db-operator@${PROJECT}.iam.gserviceaccount.com`;
const fixedJob = (name) => ["mfmf-db-operator", OPERATOR_JOB,
  OPERATOR_JOB.replace(`projects/${PROJECT}/`, `projects/${PROJECT_NUMBER}/`)].includes(name);
// Cloud Run returns short names in Job.latestCreatedExecution and Execution.job.
// Normalize only this fixed project's fixed Job, never follow an arbitrary URL.
function executionName(value) {
  if (typeof value !== "string") return null;
  const normalized = value.replace(`projects/${PROJECT_NUMBER}/`, `projects/${PROJECT}/`);
  if (/^mfmf-db-operator-[a-z0-9-]+$/.test(normalized)) return `${OPERATOR_JOB}/executions/${normalized}`;
  return new RegExp(`^${OPERATOR_JOB}/executions/mfmf-db-operator-[a-z0-9-]+$`).test(normalized) ? normalized : null;
}
const fail = (stage, status) => { throw new Error(`Database upgrade job failed: stage=${stage}${status ? ` http=${status}` : ""}; details withheld.`); };
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
export const operatorDigest = (value) => typeof value === "string" && value.startsWith(`${OPERATOR_IMAGE}@sha256:`)
  && /^[a-f0-9]{64}$/.test(value.slice(`${OPERATOR_IMAGE}@sha256:`.length));

export function validateOperatorTask(task, image, sha) {
  if (!task || task.serviceAccount !== SA || (task.maxRetries ?? 0) !== 0 || task.timeout !== "1800s"
    || task.executionEnvironment !== "EXECUTION_ENVIRONMENT_GEN2" || !isDatabaseVpc(task.vpcAccess)
    || task.volumes?.length || task.encryptionKey || task.sandboxes?.length || task.nodeSelector
    || task.workloadIdentityConfig || !Array.isArray(task.containers) || task.containers.length !== 1) fail("task-constraints");
  const c = task.containers[0];
  if (!operatorDigest(c.image) || (image && c.image !== image) || c.command?.length || !Array.isArray(c.args) || c.args.length !== 1 || c.args[0] !== "--execute"
    || c.ports?.length || c.volumeMounts?.length || c.sourceCode || c.baseImageUri
    || !exact(c.resources?.limits, ["cpu", "memory"]) || c.resources.limits.cpu !== "1" || c.resources.limits.memory !== "1Gi"
    || c.resources.cpuIdle === true || c.resources.startupCpuBoost === true
    || !Array.isArray(c.env) || c.env.length !== 3 || new Set(c.env.map((v) => v?.name)).size !== 3) fail("container-constraints");
  const values = Object.fromEntries(c.env.map((item) => [item.name, item]));
  for (const key of ["MFMF_DB_OPERATION", "MFMF_DB_DEPLOY_SHA"]) if (!exact(values[key], ["name", "value"])) fail("job-environment");
  if (values.MFMF_DB_OPERATION.value !== "upgrade" || !/^[a-f0-9]{40}$/.test(values.MFMF_DB_DEPLOY_SHA.value ?? "")
    || (sha && values.MFMF_DB_DEPLOY_SHA.value !== sha)) fail("job-environment");
  const credential = values.MFMF_DB_OPERATOR_CREDENTIALS;
  const ref = credential?.valueSource?.secretKeyRef;
  if (!exact(credential, ["name", "valueSource"]) || !exact(credential.valueSource, ["secretKeyRef"])
    || !exact(ref, ["secret", "version"]) || !["mfmf-db-operator-credentials",
      `projects/${PROJECT}/secrets/mfmf-db-operator-credentials`, `projects/${PROJECT_NUMBER}/secrets/mfmf-db-operator-credentials`].includes(ref.secret)
    || ref.version !== "1") fail("job-secret-reference");
}

export async function deployDatabaseJob({ env, image, fetchImpl = fetch,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), maxPolls = 360 }) {
  requireContinuousContext(env);
  if (env.GCP_AUTH_ENABLED !== "true" || !operatorDigest(image) || !env.GCP_ACCESS_TOKEN || /[\r\n]/.test(env.GCP_ACCESS_TOKEN)) fail("context");
  const request = async (url, stage, method = "GET", body) => {
    let response;
    try { response = await fetchImpl(url, { method, redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${env.GCP_ACCESS_TOKEN}`, "X-Goog-User-Project": PROJECT,
        ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); }
    catch { fail(stage); }
    if (!response.ok) { await response.body?.cancel(); fail(stage, response.status); }
    try { const parts = []; let size = 0;
      for await (const part of response.body) { size += part.length; if (size > 1_048_576) throw new Error(); parts.push(Buffer.from(part)); }
      return JSON.parse(Buffer.concat(parts).toString("utf8"));
    } catch { fail(stage); }
  };
  const operation = async (initial, stage) => {
    let value = initial; let name;
    for (let poll = 0; poll < maxPolls; poll++) {
      if (!value || !new RegExp(`^projects/${PROJECT}/locations/${REGION}/operations/[A-Za-z0-9_-]+$`).test(value.name ?? "")
        || (name && value.name !== name) || value.error) fail(stage);
      name = value.name;
      if (value.done === true) { if (!value.response) fail(stage); return value.response; }
      await wait(5_000); value = await request(`https://run.googleapis.com/v2/${name}`, stage);
    }
    fail("operation-timeout");
  };
  const validateJob = (job, expectedImage, sha) => {
    if (job?.name !== OPERATOR_JOB || typeof job.uid !== "string" || !job.uid || typeof job.etag !== "string" || !job.etag
      || job.deleteTime || job.reconciling === true || job.generation !== job.observedGeneration
      || job.terminalCondition?.state !== "CONDITION_SUCCEEDED" || job.template?.taskCount !== 1
      || job.template?.parallelism !== 1 || job.template.delayExecution === true
      || job.startExecutionToken || job.runExecutionToken) fail("job-identity");
    validateOperatorTask(job.template.template, expectedImage, sha);
  };
  const validateExecution = async (value, expectedName, expectedUid) => {
    if (!value || !executionName(value.name)
      || (expectedName && executionName(value.name) !== expectedName) || !fixedJob(value.job) || value.deleteTime
      || typeof value.uid !== "string" || !value.uid || value.uid.length > 128
      || (expectedUid && value.uid !== expectedUid)
      || value.taskCount !== 1 || value.parallelism !== 1) fail("execution-identity");
    let task = value.template;
    // The observed v2 Execution omits Direct VPC, although Job includes it.
    // Read the immutable v1 Execution with the same UID; never assume Job's
    // current network was also the network used by this execution.
    if (task && !Object.hasOwn(task, "vpcAccess")) {
      const shortName = executionName(value.name).split("/").pop();
      const legacy = await request(`https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT}/executions/${shortName}`, "execution-vpc");
      if (legacy?.kind !== "Execution" || legacy.metadata?.name !== shortName || legacy.metadata?.uid !== value.uid
        || ![PROJECT, PROJECT_NUMBER].includes(legacy.metadata?.namespace) || legacy.metadata?.deletionTimestamp) fail("execution-vpc");
      const annotations = [legacy.metadata?.annotations, legacy.spec?.template?.metadata?.annotations];
      if (annotations.some((a) => a !== undefined && (!a || typeof a !== "object" || Array.isArray(a)))) fail("execution-vpc");
      const annotation = (key) => {
        const values = annotations.map((a) => a?.[key]).filter((v) => v !== undefined);
        if (values.some((v) => typeof v !== "string" || v.length > 4096) || new Set(values).size > 1) fail("execution-vpc");
        return values[0];
      };
      if (annotation("run.googleapis.com/vpc-access-egress") !== "private-ranges-only"
        || annotation("run.googleapis.com/vpc-access-connector") !== undefined) fail("execution-vpc");
      let networkInterfaces;
      try { networkInterfaces = JSON.parse(annotation("run.googleapis.com/network-interfaces")); } catch { fail("execution-vpc"); }
      if (!Array.isArray(networkInterfaces) || networkInterfaces.length !== 1
        || !exact(networkInterfaces[0], ["network", "subnetwork"])) fail("execution-vpc");
      const vpcAccess = { egress: "PRIVATE_RANGES_ONLY", networkInterfaces };
      if (!isDatabaseVpc(vpcAccess)) fail("execution-vpc");
      task = { ...task, vpcAccess };
    }
    validateOperatorTask(task, image, env.GITHUB_SHA);
    return executionName(value.name);
  };
  const initial = await request(API, "read-job"); validateJob(initial);
  // Job PATCH never creates a missing Job or expands IAM; the initial operator
  // deployment and the first database cutover are separate, manual gates.
  if (initial.latestCreatedExecution?.name) {
    const name = executionName(initial.latestCreatedExecution.name);
    if (!name) fail("prior-execution");
    const previous = await request(`https://run.googleapis.com/v2/${name}`, "prior-execution");
    if (executionName(previous.name) !== name || !fixedJob(previous.job) || !previous.completionTime || (previous.runningCount ?? 0) !== 0) fail("prior-execution");
  }
  const template = structuredClone(initial.template);
  template.template.containers[0].image = image;
  template.template.containers[0].env.find((item) => item.name === "MFMF_DB_DEPLOY_SHA").value = env.GITHUB_SHA;
  const updated = await operation(await request(`${API}?allowMissing=false`, "update-job", "PATCH", {
    name: OPERATOR_JOB, etag: initial.etag, template,
  }), "update-operation");
  validateJob(updated, image, env.GITHUB_SHA);
  if (updated.uid !== initial.uid) fail("job-replaced");
  const ready = await request(API, "read-updated-job"); validateJob(ready, image, env.GITHUB_SHA);
  if (ready.uid !== initial.uid || ready.etag !== updated.etag) fail("job-changed");
  const executed = await operation(await request(`${API}:run`, "run-job", "POST", { etag: ready.etag }), "run-operation");
  const name = await validateExecution(executed);
  const finished = await request(`https://run.googleapis.com/v2/${name}`, "verify-execution"); await validateExecution(finished, name, executed.uid);
  if (!finished.completionTime || finished.reconciling === true || finished.succeededCount !== 1
    || (finished.failedCount ?? 0) !== 0 || (finished.cancelledCount ?? 0) !== 0 || (finished.runningCount ?? 0) !== 0
    || (finished.retriedCount ?? 0) !== 0 || !finished.conditions?.some((c) => c.type === "Completed" && c.state === "CONDITION_SUCCEEDED")) fail("execution-result");
  const final = await request(API, "verify-job"); validateJob(final, image, env.GITHUB_SHA);
  if (final.uid !== initial.uid || executionName(final.latestCreatedExecution?.name) !== name) fail("job-changed");
  return { upgradeVerified: true };
}
