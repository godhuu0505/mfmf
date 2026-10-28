import test from "node:test";
import assert from "node:assert/strict";
import { deployDatabaseJob, DatabaseJobError, databaseJobDiagnostic, OPERATOR_IMAGE, OPERATOR_JOB } from "../../scripts/gcp/deploy-database-job.mjs";
import { deploymentErrorMessage } from "../../scripts/gcp/deploy-existing-service.mjs";
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
function fixture({ change, failure, shortReferences = false, omittedVpc = false, legacyChange, legacyResponse, intercept } = {}) {
  let job = { name: OPERATOR_JOB, uid: "fixed-job", etag: "etag-before", generation: "1", observedGeneration: "1",
    terminalCondition: { state: "CONDITION_SUCCEEDED" }, template: { parallelism: 1, taskCount: 1, template: task() } };
  change?.(job); const calls = []; let execution;
  const op = (response) => Response.json({ name: "projects/mfmf-499612/locations/asia-northeast1/operations/fixed-operation", done: true, response });
  const fetchImpl = async (url, init) => {
    calls.push({ url, init }); assert.equal(init.redirect, "error");
    const intercepted = await intercept?.(url, init);
    if (intercepted) return intercepted;
    if (init.method === "PATCH") {
      const patch = JSON.parse(init.body); assert.equal(patch.etag, job.etag); assert.equal(patch.name, OPERATOR_JOB);
      job = { ...job, template: patch.template, etag: "etag-after" }; return op(job);
    }
    if (url === `${API}:run`) {
      assert.deepEqual(JSON.parse(init.body), { etag: "etag-after" });
      execution = { name: `${OPERATOR_JOB}/executions/mfmf-db-operator-fixture`, uid: "fixed-execution", job: OPERATOR_JOB, parallelism: 1, taskCount: 1,
        template: structuredClone(job.template.template), completionTime: "2026-10-28T00:00:00Z", succeededCount: 1,
        conditions: [{ type: "Completed", state: "CONDITION_SUCCEEDED" }] };
      if (failure === "image") execution.template.containers[0].image = `${OPERATOR_IMAGE}@sha256:${"e".repeat(64)}`;
      if (failure === "failed") { execution.succeededCount = 0; execution.failedCount = 1; }
      if (failure === "retry") execution.retriedCount = 1;
      if (failure === "foreign-job") execution.job = "other-job";
      if (failure === "vpc") execution.template.vpcAccess.egress = "ALL_TRAFFIC";
      if (omittedVpc) delete execution.template.vpcAccess;
      if (shortReferences) execution.job = "mfmf-db-operator";
      job.latestCreatedExecution = { name: shortReferences ? execution.name.split("/").pop() : execution.name }; return op(execution);
    }
    if (url === "https://asia-northeast1-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/mfmf-499612/executions/mfmf-db-operator-fixture") {
      assert.equal(init.method, "GET");
      if (legacyResponse) return legacyResponse();
      const legacy = { kind: "Execution", metadata: { name: "mfmf-db-operator-fixture", uid: execution.uid, namespace: "92772745697", annotations: {
        "run.googleapis.com/network-interfaces": JSON.stringify(DATABASE_VPC.networkInterfaces),
        "run.googleapis.com/vpc-access-egress": "private-ranges-only",
      } } };
      legacyChange?.(legacy); return Response.json(legacy);
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
test("proves omitted v2 VPC from the same immutable v1 Execution", async () => {
  const f = fixture({ shortReferences: true, omittedVpc: true }); assert.deepEqual(await f.run(), { upgradeVerified: true });
  assert.equal(f.calls.filter(({ url }) => url.includes("/apis/run.googleapis.com/v1/")).length, 2);
  assert.equal(f.calls.filter(({ init }) => init.method !== "GET").length, 2);
});
test("accepts matching nested v1 network annotations", async () => {
  const f = fixture({ omittedVpc: true, legacyChange: (v) => {
    v.metadata.namespace = "mfmf-499612";
    v.spec = { template: { metadata: { annotations: v.metadata.annotations } } }; delete v.metadata.annotations;
  } });
  assert.deepEqual(await f.run(), { upgradeVerified: true });
});
for (const [label, legacyChange] of [
  ["different UID", (v) => { v.metadata.uid = "other-execution"; }],
  ["different name", (v) => { v.metadata.name = "mfmf-db-operator-other"; }],
  ["foreign project", (v) => { v.metadata.namespace = "other-project"; }],
  ["different kind", (v) => { v.kind = "Job"; }],
  ["deleting execution", (v) => { v.metadata.deletionTimestamp = "2026-10-29T00:00:00Z"; }],
  ["absent network", (v) => { delete v.metadata.annotations; }],
  ["network JSON", (v) => { v.metadata.annotations["run.googleapis.com/network-interfaces"] = "PRIVATE_INVALID"; }],
  ["overlong network", (v) => { v.metadata.annotations["run.googleapis.com/network-interfaces"] = "PRIVATE".repeat(1000); }],
  ["extra interface", (v) => { v.metadata.annotations["run.googleapis.com/network-interfaces"] = JSON.stringify([...DATABASE_VPC.networkInterfaces, ...DATABASE_VPC.networkInterfaces]); }],
  ["foreign network", (v) => { v.metadata.annotations["run.googleapis.com/network-interfaces"] = '[{"network":"foreign","subnetwork":"mfmf-app-tokyo"}]'; }],
  ["foreign subnet", (v) => { v.metadata.annotations["run.googleapis.com/network-interfaces"] = '[{"network":"mfmf-db-network","subnetwork":"foreign"}]'; }],
  ["network tags", (v) => { v.metadata.annotations["run.googleapis.com/network-interfaces"] = '[{"network":"mfmf-db-network","subnetwork":"mfmf-app-tokyo","tags":["PRIVATE"]}]'; }],
  ["all egress", (v) => { v.metadata.annotations["run.googleapis.com/vpc-access-egress"] = "all-traffic"; }],
  ["connector", (v) => { v.metadata.annotations["run.googleapis.com/vpc-access-connector"] = "PRIVATE_CONNECTOR"; }],
  ["conflicting annotation locations", (v) => { v.spec = { template: { metadata: { annotations: { "run.googleapis.com/vpc-access-egress": "all-traffic" } } } }; }],
]) test(`rejects v1 ${label} without leaking metadata`, async () => {
  await assert.rejects(fixture({ omittedVpc: true, legacyChange }).run(), (error) => {
    assert.match(error.message, /stage=execution-vpc/); assert.doesNotMatch(error.message, /PRIVATE/); return true;
  });
});
test("does not replace explicitly invalid v2 VPC using v1", async () => {
  const f = fixture({ failure: "vpc" }); await assert.rejects(f.run());
  assert.ok(f.calls.every(({ url }) => !url.includes("/apis/run.googleapis.com/v1/")));
});
test("v1 HTTP errors remain bounded and do not expose their body", async () => {
  await assert.rejects(fixture({ omittedVpc: true, legacyResponse: () => new Response("PRIVATE_BODY", { status: 403 }) }).run(),
    (error) => { assert.match(error.message, /execution-vpc http=403/); assert.doesNotMatch(error.message, /PRIVATE/); return true; });
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

function checkDiagnostic(expected) {
  return (error) => {
    assert.ok(error instanceof DatabaseJobError);
    const diagnostic = databaseJobDiagnostic(error);
    assert.deepEqual(diagnostic, { status: "failed", component: "database-upgrade", ...expected });
    assert.deepEqual(JSON.parse(deploymentErrorMessage(error)), diagnostic);
    assert.doesNotMatch(`${error.message}${deploymentErrorMessage(error)}`, /PRIVATE/);
    return true;
  };
}
test("a read-only Job denial survives the CLI boundary without exposing the response", async () => {
  const f = fixture({ intercept: () => new Response("PRIVATE_BODY", { status: 403 }) });
  await assert.rejects(f.run(), checkDiagnostic({ stage: "read-job", httpStatus: 403, mutationBoundary: "none" }));
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].init.method, "GET");
});
test("body cancellation errors cannot replace a bounded HTTP failure", async () => {
  const f = fixture({ intercept: () => ({ ok: false, status: 403, body: { cancel: async () => { throw Error("PRIVATE_CANCEL"); } } }) });
  await assert.rejects(f.run(), checkDiagnostic({ stage: "read-job", httpStatus: 403, mutationBoundary: "none" }));
  assert.equal(f.calls.length, 1);
});
for (const method of ["PATCH", "POST"]) for (const failure of ["http", "network", "json", "operation"]) {
  test(`${method} ${failure} failure records the attempted boundary and never resends`, async () => {
    const stage = method === "PATCH" ? "update-job" : "run-job";
    const f = fixture({ intercept: (_url, init) => {
      if (init.method !== method) return;
      if (failure === "network") throw new Error("PRIVATE_NETWORK");
      if (failure === "http") return new Response("PRIVATE_BODY", { status: 403 });
      if (failure === "json") return new Response("PRIVATE_INVALID_JSON");
      return Response.json({ name: "projects/mfmf-499612/locations/asia-northeast1/operations/fixed-operation",
        done: true, error: { code: 7, message: "PRIVATE_OPERATION", details: ["PRIVATE_DETAIL"] } });
    } });
    await assert.rejects(f.run(), checkDiagnostic({ stage: failure === "operation" ? stage.replace("-job", "-operation") : stage,
      ...(failure === "http" ? { httpStatus: 403 } : {}), mutationBoundary: method === "PATCH" ? "update-requested" : "run-requested" }));
    assert.equal(f.calls.filter(({ init }) => init.method === "PATCH").length, 1);
    assert.equal(f.calls.filter(({ init }) => init.method === "POST").length, method === "PATCH" ? 0 : 1);
  });
}
test("validation failures distinguish before and after Job update", async () => {
  const before = fixture({ change: (job) => { job.template.template.containers[0].env[0].value = "import"; } });
  await assert.rejects(before.run(), checkDiagnostic({ stage: "job-environment", mutationBoundary: "none" }));
  assert.ok(before.calls.every(({ init }) => init.method === "GET"));
  let gets = 0;
  const after = fixture({ intercept: (url, init) => {
    if (url === API && init.method === "GET" && ++gets === 2) return Response.json({ uid: "PRIVATE_INVALID_JOB" });
  } });
  await assert.rejects(after.run(), checkDiagnostic({ stage: "job-identity", mutationBoundary: "update-requested" }));
  assert.equal(after.calls.filter(({ init }) => init.method === "PATCH").length, 1);
  assert.equal(after.calls.filter(({ init }) => init.method === "POST").length, 0);
});
test("completed failed execution retains the run-attempted boundary", async () => {
  const f = fixture({ failure: "failed" });
  await assert.rejects(f.run(), checkDiagnostic({ stage: "execution-result", mutationBoundary: "run-requested" }));
  assert.equal(f.calls.filter(({ init }) => init.method === "POST").length, 1);
});
test("unexpected local failure after mutation stays redacted and does not resend", async () => {
  const f = fixture({ intercept: (_url, init) => init.method === "PATCH" ? Response.json({
    name: "projects/mfmf-499612/locations/asia-northeast1/operations/fixed-operation", done: false,
  }) : undefined });
  await assert.rejects(f.run({ wait: async () => { throw Error("PRIVATE_WAIT"); } }),
    checkDiagnostic({ stage: "unexpected", mutationBoundary: "update-requested" }));
  assert.equal(f.calls.filter(({ init }) => init.method === "PATCH").length, 1);
  assert.equal(f.calls.filter(({ init }) => init.method === "POST").length, 0);
});
test("typed diagnostics use private fixed fields, never mutable error properties", () => {
  const error = new DatabaseJobError("PRIVATE_STAGE", "PRIVATE_STATUS", "PRIVATE_BOUNDARY");
  error.message = "PRIVATE_MESSAGE"; error.stage = "PRIVATE_STAGE"; error.httpStatus = "PRIVATE_STATUS";
  assert.deepEqual(databaseJobDiagnostic(error), { status: "failed", component: "database-upgrade", stage: "unexpected", mutationBoundary: "unknown" });
  assert.doesNotMatch(deploymentErrorMessage(error), /PRIVATE/);
  const copy = databaseJobDiagnostic(error); copy.stage = "PRIVATE_COPY";
  assert.doesNotMatch(deploymentErrorMessage(error), /PRIVATE/);
});
test("unknown errors and forged typed prototypes keep the generic CLI message", () => {
  const generic = "Continuous deployment failed; credentials, input and API details withheld.";
  for (const error of [new Error("PRIVATE_ERROR"), { stage: "read-job", httpStatus: 403, message: "PRIVATE_MESSAGE" },
    Object.assign(Object.create(DatabaseJobError.prototype), { message: "PRIVATE_FORGED" }), null, "PRIVATE_STRING"]) {
    assert.equal(databaseJobDiagnostic(error), null);
    assert.equal(deploymentErrorMessage(error), generic);
  }
});
