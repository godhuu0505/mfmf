import assert from "node:assert/strict";
import test from "node:test";
import { bootstrap, diagnostic, plan, validateResource, URLS, PROJECT, PROJECT_NUMBER,
  REGION, NETWORK, SUBNET, RANGE, INSTANCE } from "../../scripts/gcp/bootstrap-database.mjs";

const PRIVATE = "PRIVATE_PROVIDER_BODY_AND_TOKEN";
const COMPUTE = `https://compute.googleapis.com/compute/v1/projects/${PROJECT}`;
const SQL = `https://sqladmin.googleapis.com/v1/projects/${PROJECT}`;
const SN = "https://servicenetworking.googleapis.com/v1";
const SERVICE = `${SN}/services/servicenetworking.googleapis.com/connections`;
const copy = (value) => structuredClone(value);
function completeResources() {
  const p = plan().resources;
  return {
    network: { ...p.network, id: "101", selfLink: URLS.network, subnetworks: [URLS.subnet],
      peerings: [{ name: "servicenetworking-googleapis-com", state: "ACTIVE", importCustomRoutes: false, exportCustomRoutes: false }] },
    subnet: { ...p.subnet, id: "102", selfLink: URLS.subnet, region: `${COMPUTE}/regions/${REGION}` },
    range: { ...p.range, id: "103", selfLink: URLS.range, status: "IN_USE" },
    peering: { ...p.peering, service: "services/servicenetworking.googleapis.com", peering: "servicenetworking-googleapis-com" },
    instance: { ...p.instance, backendType: "SECOND_GEN", instanceType: "CLOUD_SQL_INSTANCE", state: "RUNNABLE",
      ipAddresses: [{ type: "PRIVATE", ipAddress: "10.85.0.3" }] },
  };
}
function fakeCloud(initial = {}, options = {}) {
  const state = copy(initial);
  const calls = [];
  const progress = [];
  const waits = [];
  const operations = new Map();
  const complete = completeResources();
  const collection = { network: `${COMPUTE}/global/networks`, subnet: `${COMPUTE}/regions/${REGION}/subnetworks`,
    range: `${COMPUTE}/global/addresses`, peering: SERVICE, instance: `${SQL}/instances` };
  const response = (value, status = 200) => new Response(JSON.stringify(value), { status });
  const fetchImpl = async (url, request) => {
    calls.push({ url, method: request.method, body: request.body ? JSON.parse(request.body) : undefined });
    assert.equal(request.redirect, "error");
    assert.equal(request.headers.Authorization, `Bearer ${PRIVATE}`);
    assert.equal(request.headers["X-Goog-User-Project"], PROJECT);
    assert.ok(["GET", "POST"].includes(request.method));
    const override = await options.intercept?.(url, request, state, calls);
    if (override !== undefined) return override;
    if (url === URLS.project) return response({ name: `projects/${PROJECT_NUMBER}`, projectId: PROJECT, state: "ACTIVE" });
    if (url.startsWith(`https://serviceusage.googleapis.com/v1/projects/${PROJECT_NUMBER}/services/`)) {
      assert.equal(request.method, "GET");
      assert.equal(new URL(url).searchParams.get("fields"), "name,state");
      return response({ name: url.replace("https://serviceusage.googleapis.com/v1/", "").split("?")[0], state: "ENABLED" });
    }
    if (operations.has(url)) return response({ ...operations.get(url), status: "DONE" });
    if (request.method === "GET") {
      const kind = Object.keys(URLS).find((key) => URLS[key] === url);
      assert.ok(kind, "no arbitrary GET endpoint");
      if (kind === "peering") return response(state.peering ? { connections: [state.peering] } : {});
      return state[kind] ? response(state[kind]) : response({ message: PRIVATE }, 404);
    }
    const kind = Object.keys(collection).find((key) => collection[key] === url);
    assert.ok(kind, "no arbitrary write endpoint");
    assert.deepEqual(JSON.parse(request.body), plan().resources[kind]);
    state[kind] = copy(complete[kind]);
    if (kind === "network") { state.network.peerings = []; state.network.subnetworks = []; }
    if (kind === "subnet") state.network.subnetworks = [URLS.subnet];
    if (kind === "peering") state.network.peerings = copy(complete.network.peerings);
    if (options.conflict === kind) return response({ message: PRIVATE }, 409);
    const op = kind === "peering" ? { name: "operations/pssn.fixture", done: true }
      : kind === "instance" ? { name: "sql-op", status: "DONE", operationType: "CREATE", targetProject: PROJECT, targetId: INSTANCE }
        : { name: `operation-${kind}`, status: "DONE", operationType: "insert", targetLink: URLS[kind] };
    if (options.pending === kind) {
      assert.notEqual(kind, "peering");
      op.status = "RUNNING";
      const scope = kind === "subnet" ? `regions/${REGION}` : "global";
      operations.set(kind === "instance" ? `${SQL}/operations/${op.name}` : `${COMPUTE}/${scope}/operations/${op.name}`, op);
    }
    return response(options.operation ? options.operation(kind, op) : op);
  };
  return { state, calls, progress, waits, run: (extra = {}) => bootstrap({ apply: true,
    env: { GCP_ACCESS_TOKEN: PRIVATE }, fetchImpl, sleepImpl: async (ms) => { waits.push(ms); },
    onProgress: (value) => progress.push(value), ...extra }) };
}
async function rejectsSafely(cloud, stage, extra = {}) {
  await assert.rejects(cloud.run(extra), (error) => {
    const report = diagnostic(error);
    if (stage) assert.equal(report.stage, stage);
    assert.equal(JSON.stringify(report).includes(PRIVATE), false);
    return true;
  });
  assert.equal(JSON.stringify(cloud.progress).includes(PRIVATE), false);
  assert.ok(cloud.calls.every((call) => ["GET", "POST"].includes(call.method)));
}

test("default plan uses neither credentials nor network", async () => {
  // v1's discovery path has no /sql prefix (v1beta4 uses /sql/v1beta4).
  assert.equal(URLS.instance, "https://sqladmin.googleapis.com/v1/projects/mfmf-499612/instances/mfmf-db");
  const result = await bootstrap({ env: new Proxy({}, { get() { throw new Error("must not access credentials"); } }),
    fetchImpl: () => { throw new Error("must not call cloud"); } });
  assert.equal(result.mode, "plan");
  assert.equal(result.projectNumber, PROJECT_NUMBER);
  assert.equal(result.budget.hardCap, false);
  assert.equal(result.resources.instance.settings.tier, "db-f1-micro");
  assert.equal(result.resources.instance.settings.finalBackupConfig.retentionDays, 30);
});
test("creates exact five resources and verifies them without IAM/enable/update/delete", async () => {
  const c = fakeCloud();
  const result = await c.run();
  assert.deepEqual(result.created, ["network", "subnet", "range", "peering", "instance"]);
  assert.equal(result.restore, "not-verified");
  assert.equal(result.runtime, "not-configured");
  assert.equal(c.calls.filter((x) => x.method === "POST").length, 5);
  assert.equal(JSON.stringify(result).includes(PRIVATE), false);
  assert.ok(c.calls.every((x) => !/:enable|setIamPolicy|password|executeSql/.test(x.url)));
});
test("idempotent rerun only reads exact existing resources", async () => {
  const c = fakeCloud(completeResources());
  const result = await c.run();
  assert.equal(result.created.length, 0);
  assert.equal(result.reused.length, 5);
  assert.ok(c.calls.every((x) => x.method === "GET"));
});
test("safe auto-growth 10..20 is compatible; no shrink or patch", async () => {
  const resources = completeResources();
  resources.instance.settings.dataDiskSizeGb = "20";
  const c = fakeCloud(resources);
  await c.run();
  assert.ok(c.calls.every((x) => x.method === "GET"));
});
test("project number or lifecycle mismatch stops before writes", async () => {
  for (const patch of [{ name: "projects/123" }, { projectId: "other" }, { state: "DELETE_REQUESTED" }]) {
    const c = fakeCloud({}, { intercept: (url) => url === URLS.project
      ? new Response(JSON.stringify({ name: `projects/${PROJECT_NUMBER}`, projectId: PROJECT, state: "ACTIVE", ...patch })) : undefined });
    await rejectsSafely(c, "project");
    assert.equal(c.calls.length, 1);
  }
});
test("disabled API stops without enabling it", async () => {
  const c = fakeCloud({}, { intercept: (url) => url.startsWith("https://serviceusage.googleapis.com/")
    ? new Response(JSON.stringify({ name: url.replace("https://serviceusage.googleapis.com/v1/", "").split("?")[0], state: "DISABLED" })) : undefined });
  await rejectsSafely(c, "apis");
  assert.ok(c.calls.every((x) => x.method === "GET"));
});
for (const [name, mutate, stage] of [
  ["public IP", (r) => { r.instance.settings.ipConfiguration.ipv4Enabled = true; }, "instance"],
  ["authorized network", (r) => { r.instance.settings.ipConfiguration.authorizedNetworks = [{ value: "0.0.0.0/0" }]; }, "instance"],
  ["connector bypass", (r) => { r.instance.settings.connectorEnforcement = "NOT_REQUIRED"; }, "instance"],
  ["wrong instance tier", (r) => { r.instance.settings.tier = "db-g1-small"; }, "instance"],
  ["wrong database major", (r) => { r.instance.databaseVersion = "POSTGRES_18"; }, "instance"],
  ["wrong network", (r) => { r.instance.settings.ipConfiguration.privateNetwork = "projects/other/global/networks/x"; }, "instance"],
  ["unbounded disk", (r) => { r.instance.settings.storageAutoResizeLimit = "0"; }, "instance"],
  ["oversize disk", (r) => { r.instance.settings.dataDiskSizeGb = "21"; }, "instance"],
  ["PITR disabled", (r) => { r.instance.settings.backupConfiguration.pointInTimeRecoveryEnabled = false; }, "instance"],
  ["weak retention", (r) => { r.instance.settings.backupConfiguration.backupRetentionSettings.retainedBackups = 7; }, "instance"],
  ["final backup disabled", (r) => { r.instance.settings.finalBackupConfig.enabled = false; }, "instance"],
  ["deletion allowed", (r) => { r.instance.settings.deletionProtectionEnabled = false; }, "instance"],
  ["backup lost on deletion", (r) => { r.instance.settings.retainBackupsOnDelete = false; }, "instance"],
  ["auto network", (r) => { r.network.autoCreateSubnetworks = true; }, "network"],
  ["unexpected subnet", (r) => { r.network.subnetworks.push(`${COMPUTE}/regions/${REGION}/subnetworks/other`); }, "network"],
  ["unexpected peering", (r) => { r.network.peerings[0].name = "other"; }, "network"],
  ["subnet CIDR", (r) => { r.subnet.ipCidrRange = "10.84.0.0/16"; }, "subnet"],
  ["Google private access off", (r) => { r.subnet.privateIpGoogleAccess = false; }, "subnet"],
  ["peering range", (r) => { r.range.address = "10.86.0.0"; }, "range"],
  ["peering scope", (r) => { r.peering.reservedPeeringRanges.push("other"); }, "peering"],
]) test(`preflight rejects ${name} without any write`, async () => {
  const r = completeResources(); mutate(r);
  const c = fakeCloud(r);
  await rejectsSafely(c, stage);
  assert.ok(c.calls.every((x) => x.method === "GET"));
});
test("concurrent matching create conflict can be safely reused", async () => {
  const c = fakeCloud({}, { conflict: "network" });
  const result = await c.run();
  assert.deepEqual(result.reused, ["network"]);
  assert.equal(result.created.length, 4);
});
test("pending operation polls only fixed target every 5 seconds", async () => {
  const c = fakeCloud({}, { pending: "instance" });
  await c.run();
  assert.deepEqual(c.waits, [5000]);
  assert.ok(c.calls.some((x) => x.url === `${SQL}/operations/sql-op`));
});
test("bounded unfinished operation fails without rollback", async () => {
  const c = fakeCloud({}, { pending: "network" });
  await rejectsSafely(c, "network", { maxPolls: 0 });
  assert.equal(c.calls.filter((x) => x.method === "POST").length, 1);
  assert.ok(c.state.network);
});
test("malicious operation name/target or provider error cannot be followed or logged", async () => {
  for (const patch of [{ name: `https://evil.example/${PRIVATE}` }, { targetLink: "https://evil.example/resource" },
    { error: { errors: [{ message: PRIVATE }] } }]) {
    const c = fakeCloud({}, { operation: (_kind, op) => ({ ...op, ...patch }) });
    await rejectsSafely(c, "network");
    assert.ok(c.calls.every((x) => !x.url.includes("evil.example")));
  }
});
test("HTTP error body unread and provider exceptions sanitized", async () => {
  let cancelled = false;
  const c = fakeCloud({}, { intercept: () => ({ status: 403, ok: false, body: {
    cancel: async () => { cancelled = true; }, [Symbol.asyncIterator]: () => { throw new Error(PRIVATE); },
  } }) });
  await rejectsSafely(c, "project");
  assert.equal(cancelled, true);
  const thrown = fakeCloud({}, { intercept: () => { throw new Error(PRIVATE); } });
  await rejectsSafely(thrown, "project");
});
test("token is required only on apply and never accepted with newlines", async () => {
  const c = fakeCloud();
  for (const token of [undefined, "", `${PRIVATE}\n`]) await rejectsSafely(c, "credentials", { env: { GCP_ACCESS_TOKEN: token } });
  assert.equal(c.calls.length, 0);
});
test("unknown outcome leaves matching created resource reusable next run", async () => {
  let lost = true;
  const c = fakeCloud({}, { intercept: (url, request, state) => {
    if (url === `${COMPUTE}/global/networks` && request.method === "POST" && lost) {
      lost = false;
      state.network = { ...completeResources().network, peerings: [], subnetworks: [] };
      throw new Error(PRIVATE);
    }
  } });
  await rejectsSafely(c, "network");
  const result = await c.run();
  assert.deepEqual(result.reused, ["network"]);
  assert.equal(result.created.length, 4);
});
test("preflight-observed resource deletion/replacement is refused", async () => {
  let reads = 0;
  const c = fakeCloud(completeResources(), { intercept: (url, _request, state) => {
    if (url === URLS.network && ++reads === 2) { state.network.id = "999"; }
  } });
  await rejectsSafely(c, "network");
  assert.ok(c.calls.every((x) => x.method === "GET"));
});
test("canonical www Google Compute self links remain compatible", () => {
  const r = completeResources();
  for (const kind of ["network", "subnet", "range"]) {
    r[kind].selfLink = r[kind].selfLink.replace("https://compute.googleapis.com/", "https://www.googleapis.com/");
    validateResource(kind, r[kind]);
  }
  assert.equal(NETWORK, "mfmf-db-network");
  assert.equal(SUBNET, "mfmf-app-tokyo");
  assert.equal(RANGE, "mfmf-sql-peering");
});
