import test from "node:test";
import assert from "node:assert/strict";
import { deployBackupJobs, validateBackupTask, backupExecutionName } from "../../scripts/gcp/deploy-backup-jobs.mjs";
import { BACKUP_JOBS, BACKUP_IMAGE, backupJobName, backupAccount, backupJobDiagnostic, BackupJobError } from "../../scripts/gcp/backup-job-config.mjs";
import { deploymentErrorMessage } from "../../scripts/gcp/deploy-existing-service.mjs";
const env = { GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "push",
  GITHUB_WORKFLOW_REF: "godhuu0505/mfmf/.github/workflows/deploy-production.yml@refs/heads/main", GITHUB_SHA: "a".repeat(40),
  GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", GCP_DEPLOY_ENABLED: "true", GCP_AUTH_ENABLED: "true",
  GCP_PROJECT_ID: "mfmf-499612", GCP_PROJECT_NUMBER: "92772745697", GCP_ACCESS_TOKEN: "PRIVATE_TOKEN" };
const image = `${BACKUP_IMAGE}@sha256:${"b".repeat(64)}`;
const task = (job) => ({ serviceAccount: backupAccount(job), maxRetries: 0, timeout: "900s", executionEnvironment: "EXECUTION_ENVIRONMENT_GEN2",
  containers: [{ image, command: ["node", "/app/scripts/gcp/run-backup-job.mjs"], args: ["--execute"], resources: { limits: { cpu: "1", memory: "512Mi" } },
    env: [{ name: "MFMF_BACKUP_DEPLOY_SHA", value: "c".repeat(40) }] }] });
function fixture({ mutateJob, mutateExecution, mutateLegacy, intercept, numberOperation = false } = {}) {
  const jobs = new Map(BACKUP_JOBS.map((job) => [job, { name: backupJobName(job), uid: job, etag: "before", generation: "1", observedGeneration: "1",
    terminalCondition: { state: "CONDITION_SUCCEEDED" }, template: { parallelism: 1, taskCount: 1, template: task(job) } }]));
  mutateJob?.(jobs.get(BACKUP_JOBS[1])); const executions = new Map(), calls = [];
  const op = (response) => Response.json({ name: `projects/${numberOperation ? "92772745697" : "mfmf-499612"}/locations/asia-northeast1/operations/fixed-op`, done: true, response });
  const fetchImpl = async (url, options) => {
    calls.push({ url, options }); assert.equal(options.redirect, "error"); const intercepted = await intercept?.(url, options); if (intercepted) return intercepted;
    const job = BACKUP_JOBS.find((j) => url.includes(`/${j}`)); assert.ok(job);
    const state = jobs.get(job);
    if (url.includes("/apis/run.googleapis.com/")) {
      const name = url.split("/").pop(); const value = { kind: "Execution", metadata: { uid: name, name, namespace: "92772745697" } };
      mutateLegacy?.(value); return Response.json(value);
    }
    if (options.method === "PATCH") {
      const patch = JSON.parse(options.body); assert.equal(patch.etag, state.etag); assert.equal(patch.name, state.name);
      state.template = patch.template; state.etag = "after"; return op(state);
    }
    if (url.endsWith(":run")) {
      assert.deepEqual(JSON.parse(options.body), { etag: "after" });
      const short = `${job}-abc12`, name = `${backupJobName(job)}/executions/${short}`;
      const value = { name, uid: short, job, parallelism: 1, taskCount: 1, template: structuredClone(state.template.template),
        completionTime: "2026-10-29T01:00:00Z", succeededCount: 1, conditions: [{ type: "Completed", state: "CONDITION_SUCCEEDED" }] };
      mutateExecution?.(value); executions.set(name, value); state.latestCreatedExecution = { name: short }; return op(value);
    }
    if (url.includes("/executions/")) return Response.json(executions.get(url.replace("https://run.googleapis.com/v2/", "")));
    assert.equal(options.method, "GET"); return Response.json(state);
  };
  return { calls, run: (extra = {}) => deployBackupJobs({ env, image, fetchImpl, wait: async () => {}, maxPolls: 2, ...extra }) };
}
test("updates and executes exactly two fixed secretless jobs, same image and main SHA", async () => {
  const f = fixture(); const proof = await f.run(); assert.equal(proof.backupsVerified, true); assert.equal(proof.jobs.length, 2);
  assert.equal(f.calls.filter((v) => v.options.method === "PATCH").length, 2);
  assert.equal(f.calls.filter((v) => v.options.method === "POST").length, 2);
  for (const c of f.calls.filter((v) => v.options.method === "PATCH")) {
    const t = JSON.parse(c.options.body).template.template; assert.equal(t.containers[0].env[0].value, env.GITHUB_SHA); assert.equal(t.containers[0].image, image);
  }
});
test("normalizes only the fixed project's operation number", async () => { assert.equal((await fixture({ numberOperation: true }).run()).backupsVerified, true); });
for (const [label, mutateJob] of [
  ["extra secret", (j) => j.template.template.containers[0].env.push({ name: "PRIVATE", valueSource: { secretKeyRef: { secret: "PRIVATE" } } })],
  ["wrong SA", (j) => { j.template.template.serviceAccount = "other"; }],
  ["VPC access", (j) => { j.template.template.vpcAccess = { egress: "ALL_TRAFFIC" }; }],
  ["different command", (j) => { j.template.template.containers[0].command = ["sh"]; }],
  ["floating image", (j) => { j.template.template.containers[0].image = `${BACKUP_IMAGE}:main`; }],
  ["multiple tasks", (j) => { j.template.taskCount = 2; }],
  ["parallelism", (j) => { j.template.parallelism = 2; }],
  ["retries", (j) => { j.template.template.maxRetries = 1; }],
  ["too much memory", (j) => { j.template.template.containers[0].resources.limits.memory = "2Gi"; }],
  ["long timeout", (j) => { j.template.template.timeout = "3600s"; }],
  ["not ready", (j) => { j.reconciling = true; }],
  ["missing UID", (j) => { delete j.uid; }],
]) test(`refuses ${label} on either job before any writes`, async () => {
  const f = fixture({ mutateJob }); await assert.rejects(f.run()); assert.ok(f.calls.every((c) => c.options.method === "GET"));
});
for (const [label, mutateExecution] of [
  ["failure", (e) => { e.failedCount = 1; }], ["retry", (e) => { e.retriedCount = 1; }],
  ["incomplete", (e) => { delete e.completionTime; }], ["foreign job", (e) => { e.job = "different-job"; }],
  ["different SHA", (e) => { e.template.containers[0].env[0].value = "d".repeat(40); }],
  ["different image", (e) => { e.template.containers[0].image = `${BACKUP_IMAGE}@sha256:${"e".repeat(64)}`; }],
]) test(`execution ${label} cannot pass or trigger second job`, async () => {
  const f = fixture({ mutateExecution }); await assert.rejects(f.run()); assert.equal(f.calls.filter((c) => c.options.method === "POST").length, 1);
});
for (const [label, mutateLegacy] of [
  ["hidden VPC", (e) => { e.metadata.annotations = { "run.googleapis.com/network-interfaces": "PRIVATE" }; }],
  ["mismatched UID", (e) => { e.metadata.uid = "other"; }],
  ["foreign project", (e) => { e.metadata.namespace = "other"; }],
]) test(`v1 execution ${label} fails closed`, async () => { await assert.rejects(fixture({ mutateLegacy }).run()); });
test("unknown PATCH outcome is never retried, and provider body never escapes", async () => {
  const f = fixture({ intercept: async (_u, o) => { if (o.method === "PATCH") throw new Error("PRIVATE_BODY"); } });
  await assert.rejects(f.run(), (e) => { assert.doesNotMatch(deploymentErrorMessage(e), /PRIVATE/); return true; });
  assert.equal(f.calls.filter((c) => c.options.method === "PATCH").length, 1); assert.equal(f.calls.filter((c) => c.options.method === "POST").length, 0);
});
test("run failure is never resubmitted", async () => {
  const f = fixture({ intercept: async (u) => u.endsWith(":run") ? new Response("PRIVATE", { status: 403 }) : undefined });
  await assert.rejects(f.run(), (e) => { assert.equal(backupJobDiagnostic(e).httpStatus, 403); assert.doesNotMatch(deploymentErrorMessage(e), /PRIVATE/); return true; });
  assert.equal(f.calls.filter((c) => c.options.method === "POST").length, 1);
});
test("PR context makes no requests", async () => { const f = fixture(); await assert.rejects(f.run({ env: { ...env, GITHUB_EVENT_NAME: "pull_request" } })); assert.equal(f.calls.length, 0); });
test("diagnostic refuses spoofed error fields", () => { const e = new Error("PRIVATE"); e.stage = "PRIVATE"; assert.equal(backupJobDiagnostic(e), null);
  assert.doesNotMatch(deploymentErrorMessage(e), /PRIVATE/); assert.equal(backupJobDiagnostic(new BackupJobError("PRIVATE", 999)).stage, "unexpected"); });
test("execution names cannot escape the fixed job", () => { assert.equal(backupExecutionName("mfmf-identity-backup-abc12", "mfmf-identity-backup"), `${backupJobName("mfmf-identity-backup")}/executions/mfmf-identity-backup-abc12`);
  assert.equal(backupExecutionName("mfmf-db-retention-abc12", "mfmf-identity-backup"), null); assert.throws(() => validateBackupTask(task("mfmf-identity-backup"), "other")); });
