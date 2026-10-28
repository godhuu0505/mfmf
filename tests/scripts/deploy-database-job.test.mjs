import test from "node:test";
import assert from "node:assert/strict";
import { deployDatabaseJob, OPERATOR_IMAGE, OPERATOR_JOB } from "../../scripts/gcp/deploy-database-job.mjs";
import { DATABASE_VPC } from "../../scripts/gcp/database-deployment-config.mjs";
const API = `https://run.googleapis.com/v2/${OPERATOR_JOB}`;
const env = { GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "push",
  GITHUB_WORKFLOW_REF: "godhuu0505/mfmf/.github/workflows/deploy-production.yml@refs/heads/main",
  GITHUB_SHA: "a".repeat(40), GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", GCP_DEPLOY_ENABLED: "true",
  GCP_AUTH_ENABLED: "true", GCP_PROJECT_ID: "mfmf-499612", GCP_PROJECT_NUMBER: "92772745697", GCP_ACCESS_TOKEN: "PRIVATE_TOKEN" };
const image = `${OPERATOR_IMAGE}@sha256:${"b".repeat(64)}`;
const task = () => ({ serviceAccount: "mfmf-db-operator@mfmf-499612.iam.gserviceaccount.com", maxRetries: 0, timeout: "1800s",
  executionEnvironment: "EXECUTION_ENVIRONMENT_GEN2", vpcAccess: structuredClone(DATABASE_VPC), containers: [{
    image: `${OPERATOR_IMAGE}@sha256:${"c".repeat(64)}`, args: ["--execute"], resources: { limits: { cpu: "1", memory: "1Gi" } }, env: [
      { name: "MFMF_DB_OPERATION", value: "upgrade" }, { name: "MFMF_DB_DEPLOY_SHA", value: "d".repeat(40) },
      { name: "MFMF_DB_OPERATOR_CREDENTIALS", valueSource: { secretKeyRef: { secret: "mfmf-db-operator-credentials", version: "1" } } },
    ] }] });
function fixture({ change, failure, shortReferences = false } = {}) {
  let job = { name: OPERATOR_JOB, uid: "fixed-job", etag: "etag-before", generation: "1", observedGeneration: "1",
    terminalCondition: { state: "CONDITION_SUCCEEDED" }, template: { parallelism: 1, taskCount: 1, template: task() } };
  change?.(job); const calls = []; let execution;
  const op = (response) => Response.json({ name: "projects/mfmf-499612/locations/asia-northeast1/operations/fixed-operation", done: true, response });
  const fetchImpl = async (url, init) => {
    calls.push({ url, init }); assert.equal(init.redirect, "error");
    if (init.method === "PATCH") {
      const patch = JSON.parse(init.body); assert.equal(patch.etag, job.etag); assert.equal(patch.name, OPERATOR_JOB);
      job = { ...job, template: patch.template, etag: "etag-after" }; return op(job);
    }
    if (url === `${API}:run`) {
      assert.deepEqual(JSON.parse(init.body), { etag: "etag-after" });
      execution = { name: `${OPERATOR_JOB}/executions/mfmf-db-operator-fixture`, job: OPERATOR_JOB, parallelism: 1, taskCount: 1,
        template: structuredClone(job.template.template), completionTime: "2026-10-28T00:00:00Z", succeededCount: 1,
        conditions: [{ type: "Completed", state: "CONDITION_SUCCEEDED" }] };
      if (failure === "image") execution.template.containers[0].image = `${OPERATOR_IMAGE}@sha256:${"e".repeat(64)}`;
      if (failure === "failed") { execution.succeededCount = 0; execution.failedCount = 1; }
      if (failure === "retry") execution.retriedCount = 1;
      if (failure === "foreign-job") execution.job = "other-job";
      if (shortReferences) execution.job = "mfmf-db-operator";
      job.latestCreatedExecution = { name: shortReferences ? execution.name.split("/").pop() : execution.name }; return op(execution);
    }
    if (url === `https://run.googleapis.com/v2/${execution?.name}`) return Response.json(execution);
    if (url === API) return Response.json(job);
    throw new Error("PRIVATE_UNEXPECTED");
  };
  return { calls, run: (extra = {}) => deployDatabaseJob({ env, image, fetchImpl, wait: async () => {}, maxPolls: 2, ...extra }) };
}
test("updates only an existing fixed job and verifies one successful exact-image execution", async () => {
  const f = fixture(); assert.deepEqual(await f.run(), { upgradeVerified: true });
  const writes = f.calls.filter(({ init }) => init.method !== "GET"); assert.equal(writes.length, 2);
  assert.equal(writes[0].url, `${API}?allowMissing=false`);
  const patch = JSON.parse(writes[0].init.body); assert.equal(patch.template.template.containers[0].image, image);
  assert.equal(patch.template.template.containers[0].env[1].value, env.GITHUB_SHA);
  assert.equal(writes[1].url, `${API}:run`);
});
test("accepts the observed API short execution reference and parent Job name", async () => {
  const f = fixture({ shortReferences: true }); assert.deepEqual(await f.run(), { upgradeVerified: true });
  assert.ok(f.calls.filter(({ url }) => url.includes("/executions/")).every(({ url }) => url.startsWith(`${API}/executions/mfmf-db-operator-`)));
});
for (const [label, change] of [
  ["foreign service account", (j) => { j.template.template.serviceAccount = "other"; }],
  ["public route", (j) => { j.template.template.vpcAccess.egress = "ALL_TRAFFIC"; }],
  ["different subnet", (j) => { j.template.template.vpcAccess.networkInterfaces[0].subnetwork = "other"; }],
  ["extra container", (j) => { j.template.template.containers.push(task().containers[0]); }],
  ["plan default", (j) => { j.template.template.containers[0].args = []; }],
  ["different secret", (j) => { j.template.template.containers[0].env[2].valueSource.secretKeyRef.secret = "other"; }],
  ["floating secret", (j) => { j.template.template.containers[0].env[2].valueSource.secretKeyRef.version = "latest"; }],
  ["retry", (j) => { j.template.template.maxRetries = 1; }],
  ["multiple tasks", (j) => { j.template.taskCount = 2; }],
  ["import operation", (j) => { j.template.template.containers[0].env[0].value = "import"; }],
]) test(`rejects ${label} before update/run`, async () => {
  const f = fixture({ change }); await assert.rejects(f.run()); assert.ok(f.calls.every(({ init }) => init.method === "GET"));
});
for (const failure of ["image", "failed", "retry", "foreign-job"]) test(`never succeeds with execution ${failure}`, async () => {
  await assert.rejects(fixture({ failure }).run());
});
test("disabled mode and PR context cannot access the job", async () => {
  const f = fixture(); await assert.rejects(f.run({ env: { ...env, GCP_AUTH_ENABLED: "false" } }));
  await assert.rejects(f.run({ env: { ...env, GITHUB_EVENT_NAME: "pull_request" } })); assert.equal(f.calls.length, 0);
});
