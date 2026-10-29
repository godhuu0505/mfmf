import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PROJECT, PROJECT_NUMBER, REGION, ACCOUNTS, JOBS, ROLES, IDENTITY_BUCKET, OPS_BUCKET, IMAGE_PREFIX, RECEIPT_OBJECT,
  backupBucketConfig, validateBackupBucket, planPolicy, validateBackupJob, schedulerConfig, validateScheduler, validateExecution, validateLegacyExecution, bootstrapBackups } from "../../scripts/gcp/bootstrap-backups.mjs";

const PARENT = `projects/${PROJECT}/locations/${REGION}`;
const SHA = "a".repeat(40);
const IMAGE = `${IMAGE_PREFIX}${"b".repeat(64)}`;
const NOW = Date.parse("2026-10-29T00:00:00Z");
const policy = () => ({ version: 3, etag: "fixed-policy-etag", bindings: [] });
const role = (id) => `projects/${PROJECT}/roles/${id}`;
const member = (id) => `serviceAccount:${id}@${PROJECT}.iam.gserviceaccount.com`;
const job = (id) => ({ name: `${PARENT}/jobs/${id}`, uid: `uid-${id}`, etag: `etag-${id}`, generation: "1", observedGeneration: "1", terminalCondition: { state: "CONDITION_SUCCEEDED" },
  template: { taskCount: 1, parallelism: 1, template: { serviceAccount: `${id}@${PROJECT}.iam.gserviceaccount.com`, executionEnvironment: "EXECUTION_ENVIRONMENT_GEN2", timeout: "900s", maxRetries: 0,
    containers: [{ image: IMAGE, command: ["node", "/app/scripts/gcp/run-backup-job.mjs"], args: ["--execute"], env: [{ name: "MFMF_BACKUP_DEPLOY_SHA", value: SHA }], resources: { limits: { cpu: "1", memory: "512Mi" } } }] } } });
const execution = (id) => ({ name: `${PARENT}/jobs/${id}/executions/${id}-proof`, uid: `exec-${id}`, job: `${PARENT}/jobs/${id}`, taskCount: 1, parallelism: 1, succeededCount: 1,
  conditions: [{ type: "Completed", state: "CONDITION_SUCCEEDED" }], startTime: "2026-10-28T23:58:00Z", completionTime: "2026-10-28T23:59:00Z", template: structuredClone(job(id).template.template) });
const fullBucket = (name) => ({ ...backupBucketConfig(name), projectNumber: PROJECT_NUMBER });
function harness() {
  const state = { apis: new Map(), accounts: new Map(), roles: new Map(), buckets: new Map(), projectPolicy: policy(), saPolicies: new Map(), bucketPolicies: new Map(), jobs: new Map(), jobPolicies: new Map(), schedules: new Map(), executions: new Map(), keys: new Map() };
  for (const name of ["iam.googleapis.com", "storage.googleapis.com", "run.googleapis.com", "cloudresourcemanager.googleapis.com", "identitytoolkit.googleapis.com", "sqladmin.googleapis.com", "cloudscheduler.googleapis.com"]) state.apis.set(name, "ENABLED");
  state.projectPolicy.bindings.push({ role: "roles/cloudscheduler.serviceAgent", members: [`serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-cloudscheduler.iam.gserviceaccount.com`] });
  const calls = []; const logs = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input); const body = init.body ? JSON.parse(init.body) : undefined;
    assert.equal(init.headers.Authorization, "Bearer fake-bootstrap-token"); assert.equal(init.headers["X-Goog-User-Project"], PROJECT); assert.equal(init.redirect, "error"); assert.ok(init.signal);
    calls.push({ url: url.href, method: init.method, body });
    let value; const p = url.pathname;
    if (url.hostname === "serviceusage.googleapis.com") {
      const name = p.split("/").at(-1).replace(":enable", "");
      if (p.endsWith(":enable")) { assert.equal(name, "cloudscheduler.googleapis.com"); state.apis.set(name, "ENABLED"); value = { name: "operations/acf.p2-enabled-scheduler", done: true }; }
      else value = { name: `projects/${PROJECT_NUMBER}/services/${name}`, state: state.apis.get(name) };
    } else if (url.hostname === "cloudresourcemanager.googleapis.com") {
      if (p.endsWith(":setIamPolicy")) state.projectPolicy = body.policy;
      value = state.projectPolicy;
    } else if (url.hostname === "iam.googleapis.com") {
      if (p.endsWith("/serviceAccounts") && init.method === "POST") { const id = body.accountId; value = { email: `${id}@${PROJECT}.iam.gserviceaccount.com`, projectId: PROJECT, uniqueId: "123456789" }; state.accounts.set(id, value); state.saPolicies.set(id, policy()); }
      else if (p.endsWith("/roles") && init.method === "POST") { value = { ...body.role, name: role(body.roleId) }; state.roles.set(body.roleId, value); }
      else if (p.includes("/roles/")) value = state.roles.get(p.split("/").at(-1));
      else { const id = p.split("/serviceAccounts/")[1].split("@")[0];
        if (p.endsWith("/keys")) value = { keys: state.keys.get(id) ?? [] };
        else if (p.endsWith(":setIamPolicy")) { state.saPolicies.set(id, body.policy); value = body.policy; }
        else if (p.endsWith(":getIamPolicy")) value = state.saPolicies.get(id);
        else value = state.accounts.get(id);
      }
    } else if (url.hostname === "storage.googleapis.com") {
      if (p === "/storage/v1/b" && init.method === "POST") { value = { ...body, projectNumber: PROJECT_NUMBER }; state.buckets.set(body.name, value); state.bucketPolicies.set(body.name, policy()); }
      else { const name = p.split("/b/")[1].split("/")[0];
        if (p.endsWith("/iam")) { if (init.method === "PUT") state.bucketPolicies.set(name, body); value = state.bucketPolicies.get(name); }
        else value = state.buckets.get(name);
      }
    } else if (url.hostname === "run.googleapis.com") {
      const id = p.split("/jobs/")[1].split(/[/:]/)[0];
      if (p.endsWith(":getIamPolicy")) value = state.jobPolicies.get(id);
      else if (p.endsWith(":setIamPolicy")) { value = body.policy; state.jobPolicies.set(id, value); }
      else if (p.includes("/executions/")) value = state.executions.get(p.split("/").at(-1));
      else value = state.jobs.get(id);
    } else if (url.hostname === `${REGION}-run.googleapis.com`) {
      const exec = state.executions.get(p.split("/").at(-1));
      value = exec && { kind: "Execution", metadata: { uid: exec.uid, name: exec.name.split("/").at(-1), namespace: PROJECT } };
    } else if (url.hostname === "cloudscheduler.googleapis.com") {
      if (init.method === "POST") { value = { ...body, state: "ENABLED" }; state.schedules.set(body.name.split("/").at(-1), value); }
      else value = state.schedules.get(p.split("/").at(-1));
    } else assert.fail("unexpected host");
    return new Response(value === undefined ? "{}" : JSON.stringify(value), { status: value === undefined ? 404 : 200 });
  };
  const options = { token: "fake-bootstrap-token", fetchImpl, now: () => NOW, log: (s) => logs.push(s), sleep: async () => {} };
  const addJobs = () => { for (const id of JOBS) { state.jobs.set(id, job(id)); state.jobPolicies.set(id, policy()); state.executions.set(`${id}-proof`, execution(id)); } };
  const writes = () => calls.filter((c) => ["PUT", "PATCH", "DELETE"].includes(c.method) || c.method === "POST" && !c.url.includes(":getIamPolicy"));
  return { state, calls, logs, options, addJobs, writes };
}

test("default CLI is offline, fixed-resource plan with no credentials or mutation", () => {
  const path = fileURLToPath(new URL("../../scripts/gcp/bootstrap-backups.mjs", import.meta.url));
  const result = JSON.parse(execFileSync(process.execPath, [path], { env: { PATH: "/nonexistent" }, encoding: "utf8" }));
  assert.equal(result.workloadExecutionsStarted, false); assert.equal(result.receiptObject, "retention/latest.json"); assert.deepEqual(result.phaseOrder, ["prepare", "bind-jobs", "schedule"]);
});
test("inspect performs only reads even when resources do not exist", async () => { const h = harness(); await bootstrapBackups(h.options); assert.equal(h.writes().length, 0); });
test("three phases preserve existing project IAM, verify resources, then schedule only proven jobs", async () => {
  const h = harness(); h.state.projectPolicy.bindings.push({ role: "roles/viewer", members: ["user:fixture@example.invalid"] });
  h.state.apis.set("cloudscheduler.googleapis.com", "DISABLED");
  await bootstrapBackups({ ...h.options, phase: "prepare" }); assert.equal(h.state.accounts.size, 3); assert.equal(h.state.buckets.size, 2); assert.equal(h.state.roles.size, 8); assert.equal(h.state.schedules.size, 0);
  assert.ok(h.state.projectPolicy.bindings.some((b) => b.members.includes("user:fixture@example.invalid")));
  h.addJobs(); await bootstrapBackups({ ...h.options, phase: "bind-jobs" }); assert.equal(h.state.schedules.size, 0);
  await bootstrapBackups({ ...h.options, phase: "schedule", executions: Object.fromEntries(JOBS.map((id) => [id, `${id}-proof`])) });
  assert.equal(h.state.schedules.size, 2); assert.ok(h.writes().every((c) => !c.url.endsWith(":run") && !c.url.includes("/keys")));
  const initialWrites = h.writes().length;
  await bootstrapBackups({ ...h.options, phase: "prepare" }); await bootstrapBackups({ ...h.options, phase: "bind-jobs" });
  await bootstrapBackups({ ...h.options, phase: "schedule", executions: Object.fromEntries(JOBS.map((id) => [id, `${id}-proof`])) }); assert.equal(h.writes().length, initialWrites);
});
test("missing jobs cannot cause automatic creation or scheduling", async () => { const h = harness(); await assert.rejects(bootstrapBackups({ ...h.options, phase: "bind-jobs" })); assert.equal(h.writes().length, 0); });
test("only Scheduler API may be enabled", async () => { const h = harness(); h.state.apis.set("run.googleapis.com", "DISABLED"); await assert.rejects(bootstrapBackups({ ...h.options, phase: "prepare" })); assert.equal(h.writes().length, 0); });
test("Service Usage config GET projects only required metadata", async () => { const h = harness(); await bootstrapBackups(h.options); for (const c of h.calls.filter((c) => c.url.includes("serviceusage.googleapis.com"))) assert.equal(new URL(c.url).searchParams.get("fields"), "name,state"); });
test("invalid Service Usage operation paths stop without polling or later writes", async () => {
  for (const name of ["operations/..", "operations/acf..bad", "operations/abc/foreign", "operations/abc?token=private", "https://evil.invalid/operation"]) {
    const h = harness(); h.state.apis.set("cloudscheduler.googleapis.com", "DISABLED"); const base = h.options.fetchImpl;
    h.options.fetchImpl = async (url, init) => url.endsWith(":enable") ? Response.json({ name, done: false }) : base(url, init);
    await assert.rejects(bootstrapBackups({ ...h.options, phase: "prepare" })); assert.equal(h.writes().length, 0);
    assert.ok(h.calls.every((c) => !c.url.includes("/operations/")));
  }
});
test("unknown existing account grant is rejected before mutation", async () => {
  const h = harness(); h.state.accounts.set(ACCOUNTS[0], { email: `${ACCOUNTS[0]}@${PROJECT}.iam.gserviceaccount.com`, projectId: PROJECT, uniqueId: "123" });
  h.state.saPolicies.set(ACCOUNTS[0], { ...policy(), bindings: [{ role: "roles/iam.serviceAccountTokenCreator", members: ["user:other@example.invalid"] }] });
  await assert.rejects(bootstrapBackups({ ...h.options, phase: "prepare" })); assert.equal(h.writes().length, 0);
});
test("user-managed account keys stop before any mutation", async () => {
  const h = harness(); h.state.accounts.set(ACCOUNTS[0], { email: `${ACCOUNTS[0]}@${PROJECT}.iam.gserviceaccount.com`, projectId: PROJECT, uniqueId: "123" }); h.state.keys.set(ACCOUNTS[0], [{ name: "private-marker" }]);
  await assert.rejects(bootstrapBackups({ ...h.options, phase: "prepare" })); assert.equal(h.writes().length, 0); assert.equal(h.logs.join("").includes("private-marker"), false);
});
test("widened role permissions stop before mutation", async () => { const h = harness(); h.state.roles.set(ROLES[0].id, { name: role(ROLES[0].id), stage: "GA", includedPermissions: [...ROLES[0].permissions, "firebaseauth.users.delete"] }); await assert.rejects(bootstrapBackups({ ...h.options, phase: "prepare" })); assert.equal(h.writes().length, 0); });
for (const [label, mutate] of [
  ["wrong project", (b) => { b.projectNumber = "123"; }], ["public", (b) => { b.iamConfiguration.publicAccessPrevention = "inherited"; }],
  ["no UBLA", (b) => { b.iamConfiguration.uniformBucketLevelAccess.enabled = false; }], ["versioning", (b) => { b.versioning.enabled = true; }],
  ["wrong location", (b) => { b.location = "US"; }], ["short softdelete", (b) => { b.softDeletePolicy.retentionDurationSeconds = "0"; }],
  ["short retention", (b) => { b.retentionPolicy.retentionPeriod = "60"; }], ["locked retention", (b) => { b.retentionPolicy.isLocked = true; }],
  ["broad lifecycle", (b) => { delete b.lifecycle.rule[0].condition.matchesPrefix; }], ["CORS", (b) => { b.cors = [{ origin: ["*"] }]; }],
  ["event hold", (b) => { b.defaultEventBasedHold = true; }],
]) test(`bucket drift is rejected: ${label}`, () => { const actual = fullBucket(IDENTITY_BUCKET); mutate(actual); assert.throws(() => validateBackupBucket(actual, backupBucketConfig(IDENTITY_BUCKET))); });
test("ops bucket is mutable only via exact object policy, without retention/lifecycle/versioning", () => {
  const actual = fullBucket(OPS_BUCKET); validateBackupBucket(actual, backupBucketConfig(OPS_BUCKET)); actual.retentionPolicy = { retentionPeriod: "2592000" }; assert.throws(() => validateBackupBucket(actual, backupBucketConfig(OPS_BUCKET))); assert.equal(RECEIPT_OBJECT, "retention/latest.json");
});
test("policy rejects public principals and alternative unconditional access", () => {
  assert.throws(() => planPolicy({ ...policy(), bindings: [{ role: "roles/viewer", members: ["allUsers"] }] }, []));
  const m = member(ACCOUNTS[0]); const wanted = [{ role: role("mfmfBackupObjectWriter"), members: [m], condition: { title: "scope", expression: "resource.name.startsWith('fixed/')" } }];
  assert.throws(() => planPolicy({ ...policy(), bindings: [{ role: wanted[0].role, members: [m] }] }, wanted, [m]));
});
for (const [label, mutate] of [
  ["secret", (j) => { j.template.template.containers[0].env.push({ name: "KEY", valueSource: {} }); }],
  ["wrong SA", (j) => { j.template.template.serviceAccount = "other@invalid"; }],
  ["VPC", (j) => { j.template.template.vpcAccess = { connector: "other" }; }],
  ["retry", (j) => { j.template.template.maxRetries = 1; }], ["extra task", (j) => { j.template.taskCount = 2; }],
  ["mutable image", (j) => { j.template.template.containers[0].image = "example/image:latest"; }],
  ["command", (j) => { j.template.template.containers[0].command = ["sh"]; }], ["memory", (j) => { j.template.template.containers[0].resources.limits.memory = "1Gi"; }],
  ["not ready", (j) => { j.terminalCondition.state = "CONDITION_FAILED"; }], ["reconciling", (j) => { j.reconciling = true; }],
]) test(`job gate rejects ${label}`, () => { const actual = job(JOBS[0]); mutate(actual); assert.throws(() => validateBackupJob(actual, JOBS[0])); });
test("schedule target cannot be arbitrary or retry service requests", () => {
  const expected = schedulerConfig(JOBS[0]); const actual = { ...structuredClone(expected), state: "ENABLED" }; validateScheduler(actual, expected);
  actual.httpTarget.uri = "https://evil.invalid/token"; assert.throws(() => validateScheduler(actual, expected)); actual.httpTarget.uri = expected.httpTarget.uri; actual.retryConfig.retryCount = 1; assert.throws(() => validateScheduler(actual, expected));
});
for (const [label, mutate] of [
  ["old proof", (e) => { e.startTime = "2026-10-26T00:00:00Z"; e.completionTime = "2026-10-26T00:01:00Z"; }],
  ["failed", (e) => { e.failedCount = 1; }], ["retried", (e) => { e.retriedCount = 1; }],
  ["wrong job", (e) => { e.job = `${PARENT}/jobs/other`; }], ["wrong image", (e) => { e.template.containers[0].image = `${IMAGE_PREFIX}${"c".repeat(64)}`; }],
  ["wrong SHA", (e) => { e.template.containers[0].env[0].value = "c".repeat(40); }],
]) test(`execution proof rejects ${label}`, () => { const actual = execution(JOBS[0]); mutate(actual); assert.throws(() => validateExecution(actual, job(JOBS[0]), JOBS[0], NOW)); });
test("API errors/JSON are withheld and mutations are not retried", async () => {
  const h = harness(); const original = h.options.fetchImpl; let writes = 0;
  h.options.fetchImpl = async (u, init) => { if (u.endsWith("/serviceAccounts") && init.method === "POST") { writes++; return new Response("secret-marker", { status: 403 }); } return original(u, init); };
  await assert.rejects(bootstrapBackups({ ...h.options, phase: "prepare" }), (e) => !e.message.includes("secret-marker")); assert.equal(writes, 1); assert.equal(h.logs.join("").includes("secret-marker"), false);
});
test("malformed API response never appears in exception", async () => { await assert.rejects(bootstrapBackups({ token: "fake", fetchImpl: async () => new Response("private-marker"), log: () => {} }), (e) => !e.message.includes("private-marker")); });
test("schedule proof names rejected before network path interpolation", async () => {
  const h = harness(); await bootstrapBackups({ ...h.options, phase: "prepare" }); h.addJobs(); await bootstrapBackups({ ...h.options, phase: "bind-jobs" }); const calls = h.calls.length;
  await assert.rejects(bootstrapBackups({ ...h.options, phase: "schedule", executions: { [JOBS[0]]: "../evil", [JOBS[1]]: `${JOBS[1]}-proof` } })); assert.ok(h.calls.slice(calls).every((c) => !c.url.includes("evil"))); assert.equal(h.state.schedules.size, 0);
});
test("immutable v1 execution cannot hide a VPC attachment", () => {
  const e = execution(JOBS[0]); const legacy = { kind: "Execution", metadata: { uid: e.uid, name: e.name.split("/").at(-1), namespace: PROJECT } };
  validateLegacyExecution(legacy, e); legacy.spec = { template: { metadata: { annotations: { "run.googleapis.com/network-interfaces": "hidden-network" } } } };
  assert.throws(() => validateLegacyExecution(legacy, e));
});
test("missing standard scheduler service agent blocks scheduling without granting it silently", async () => {
  const h = harness(); await bootstrapBackups({ ...h.options, phase: "prepare" }); h.addJobs(); await bootstrapBackups({ ...h.options, phase: "bind-jobs" });
  h.state.projectPolicy.bindings = h.state.projectPolicy.bindings.filter((b) => b.role !== "roles/cloudscheduler.serviceAgent");
  const before = h.writes().length;
  await assert.rejects(bootstrapBackups({ ...h.options, phase: "schedule", executions: Object.fromEntries(JOBS.map((id) => [id, `${id}-proof`])) }));
  assert.equal(h.writes().length, before); assert.equal(h.state.schedules.size, 0);
});
