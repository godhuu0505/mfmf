import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { PROJECT, PROJECT_NUMBER, REGION, JOBS, OWNER, plan, policyDefinitions, successTotal,
  alertPolicy, notificationChannel, dashboard, uptimeCheck, uptimeAlertPolicy, validateManaged, parsePrometheusNumber, bootstrapObservability } from "../../scripts/gcp/bootstrap-observability.mjs";

const PRIVATE = "PRIVATE_PROVIDER_AND_TOKEN";
const EMAIL = "operator@example.invalid";
const NOW = Date.parse("2026-10-29T03:30:00Z");
const channelName = `projects/${PROJECT_NUMBER}/notificationChannels/123`;
const name = (collection, id) => `projects/${PROJECT_NUMBER}/${collection}/${id}`;
const vector = (n) => ({ status: "success", data: { resultType: "vector", result: [{ metric: {}, value: [NOW / 1000, String(n)] }] } });
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
function dashboardResponseDefaults(row) {
  row.gridLayout.widgets[0].text.style = {};
  for (const widget of row.gridLayout.widgets.slice(1)) {
    widget.xyChart.dataSets[0].targetAxis = "Y1";
    delete widget.xyChart.yAxis.label;
  }
  return row;
}
function fake({ enabled = false, counts = [1, 1], hook } = {}) {
  const calls = [], logs = [], state = { enabled, channels: [], policies: [], dashboards: [], uptime: [] };
  const api = async (input, options) => {
    const u = new URL(input), body = options.body ? JSON.parse(options.body) : undefined;
    const call = { url: u.href, method: options.method, body }; calls.push(call);
    assert.equal(options.redirect, "error"); assert.equal(options.headers.Authorization, `Bearer ${PRIVATE}`); assert.equal(options.headers["X-Goog-User-Project"], PROJECT);
    const override = await hook?.({ u, call, state, calls }); if (override !== undefined) return override;
    if (u.hostname === "cloudresourcemanager.googleapis.com") { assert.equal(options.method, "GET"); return response({ projectId: PROJECT, projectNumber: PROJECT_NUMBER, lifecycleState: "ACTIVE" }); }
    if (u.hostname === "serviceusage.googleapis.com") {
      if (u.pathname.endsWith(":enable")) { assert.equal(options.method, "POST"); assert.equal(u.pathname, `/v1/projects/${PROJECT_NUMBER}/services/appoptimize.googleapis.com:enable`); state.enabled = true; return response({ name: "operations/acf.fixed", done: true }); }
      assert.equal(options.method, "GET"); const api = u.pathname.split("/").at(-1);
      return response({ name: `projects/${PROJECT_NUMBER}/services/${api}`, state: api === "appoptimize.googleapis.com" && !state.enabled ? "DISABLED" : "ENABLED" });
    }
    assert.equal(u.hostname, "monitoring.googleapis.com");
    if (u.pathname.endsWith("/timeSeries")) {
      assert.equal(options.method, "GET"); const filter = u.searchParams.get("filter"), i = JOBS.findIndex((job) => filter.includes(`job_name="${job}"`)); assert.ok(i >= 0);
      assert.ok(filter.includes('result="succeeded"'));
      return response({ timeSeries: counts[i] === 0 ? [] : [{ metricKind: "DELTA", valueType: "INT64", metric: { type: "run.googleapis.com/job/completed_execution_count", labels: { result: "succeeded" } },
        resource: { type: "cloud_run_job", labels: { project_id: PROJECT, location: REGION, job_name: JOBS[i] } },
        points: [{ value: { int64Value: "0" } }, { value: { int64Value: String(counts[i]) } }] }] });
    }
    if (u.pathname.endsWith("/query")) { assert.equal(options.method, "GET"); const query = u.searchParams.get("query"), i = JOBS.findIndex((job) => query.includes(job)); assert.ok(i >= 0); return response(vector(query.includes("unless on()") ? 0 : counts[i])); }
    const collection = u.pathname.split("/").at(-1), table = { notificationChannels: "channels", alertPolicies: "policies", dashboards: "dashboards", uptimeCheckConfigs: "uptime" }[collection]; assert.ok(table);
    if (options.method === "GET") return response({ [collection]: structuredClone(state[table]) });
    assert.equal(options.method, "POST"); const row = { ...structuredClone(body), name: name(collection, table === "channels" ? "123" : String(state[table].length + 100)) };
    if (table === "channels") row.verificationStatus = "VERIFICATION_STATUS_UNSPECIFIED";
    if (table === "policies") { row.conditions[0].name = `${row.name}/conditions/001`; row.creationRecord = { mutatedBy: PRIVATE }; }
    if (table === "dashboards") { row.etag = "etag"; dashboardResponseDefaults(row); }
    state[table].push(row); return response(row);
  };
  return { state, calls, logs, run: (apply = false) => bootstrapObservability({ token: PRIVATE, email: EMAIL, apply, fetchImpl: api, sleep: async () => {}, now: () => NOW, log: (s) => logs.push(s) }) };
}

test("default plan has no environment or network dependency and no contact output", () => {
  const child = spawnSync(process.execPath, ["scripts/gcp/bootstrap-observability.mjs", "--plan"], { cwd: new URL("../..", import.meta.url), env: {}, encoding: "utf8" });
  assert.equal(child.status, 0); const p = JSON.parse(child.stdout); assert.equal(p.dashboards, 1); assert.equal(p.policies.length, 7); assert.equal(p.optionalApiToEnable, "appoptimize.googleapis.com");
  assert.equal(p.iamChanges, false); assert.equal(p.customMetrics, false); assert.equal(p.uptimeChecks, 1); assert.equal(p.absenceHours, 30);
});
test("inspect compares sparse DELTA with exact PromQL using GET only", async () => {
  const f = fake(); const result = await f.run(); assert.equal(result.queryProof, true); assert.deepEqual(result.successCounts, [1, 1]);
  assert.deepEqual(result.changes, { api: 1, channel: 1, dashboard: 1, uptime: 1, policies: 7 }); assert.ok(f.calls.every((c) => c.method === "GET"));
  assert.ok(!JSON.stringify(f.logs).includes(EMAIL)); assert.ok(!JSON.stringify(f.logs).includes(PRIVATE));
});
test("first apply creates fixed resources only; second apply has zero mutations", async () => {
  const f = fake(); assert.equal((await f.run(true)).verified, true);
  const writes = f.calls.filter((c) => c.method !== "GET"); assert.equal(writes.length, 11); assert.ok(writes.every((c) => c.method === "POST"));
  assert.equal(f.state.policies.length, 7); assert.equal(f.state.channels.length, 1); assert.equal(f.state.dashboards.length, 1);
  f.calls.length = 0; assert.deepEqual((await f.run(true)).changes, { api: 0, channel: 0, dashboard: 0, uptime: 0, policies: 0 }); assert.ok(f.calls.every((c) => c.method === "GET"));
});
test("zero success and absent series do not prevent deploying the missing-success alarm", async () => {
  const f = fake({ counts: [0, 0] }); assert.deepEqual((await f.run(true)).successCounts, [0, 0]);
});
test("daily sparse and multiple same-day successes remain separate per job", async () => {
  const f = fake({ counts: [1, 7] }); assert.deepEqual((await f.run()).successCounts, [1, 7]);
  const stale = policyDefinitions().filter((d) => d.id.endsWith("stale")); assert.equal(stale.length, 2);
  for (let i = 0; i < 2; i++) { assert.ok(stale[i].query.includes(JOBS[i])); assert.ok(!stale[i].query.includes(JOBS[1 - i])); assert.ok(stale[i].query.includes("sum_over_time")); assert.ok(stale[i].query.includes("or vector(0)")); assert.ok(stale[i].query.endsWith(" < 1")); assert.ok(!stale[i].query.includes("bool")); assert.equal(stale[i].duration, "0s"); assert.equal(stale[i].interval, "300s"); }
});
test("policy thresholds and non-mutating runbook are explicit", () => {
  const defs = policyDefinitions(); assert.match(defs.find((d) => d.id === "backup-failed").query, /sum by \(job_name\)/);
  assert.match(defs.find((d) => d.id === "app-errors").query, /\[5m\]\)\) >= 3$/);
  assert.match(defs.find((d) => d.id === "database-down").query, /or vector\(0\)/);
  assert.equal(defs.find((d) => d.id === "database-storage").duration, "900s");
  for (const d of defs) { const p = alertPolicy(d, channelName); assert.equal(p.enabled, true); assert.equal(p.notificationChannels.length, 1); assert.ok(p.documentation.content.includes("Runbook")); }
});
test("dashboard links fixed Cloud Hub and includes standard metrics only", () => {
  const d = dashboard(); assert.equal(d.gridLayout.widgets.length, 8); const json = JSON.stringify(d);
  assert.ok(json.includes(`https://console.cloud.google.com/cloud-hub?project=${PROJECT}`));
  assert.ok(json.includes(`https://console.cloud.google.com/cloud-hub/optimization?project=${PROJECT}`));
  assert.ok(!json.includes("console.cloud.google.com/hub")); assert.ok(!json.includes("custom.googleapis.com")); assert.ok(!json.includes("email_address"));
});
test("dashboard accepts only observed empty style, Y1 and omitted empty label defaults", () => {
  const desired = dashboard(), actual = dashboardResponseDefaults({ ...structuredClone(desired), name: name("dashboards", "a") });
  const original = structuredClone(actual);
  assert.equal(validateManaged(actual, desired, "dashboard"), actual.name);
  assert.deepEqual(actual, original); assert.equal(desired.gridLayout.widgets[1].xyChart.yAxis.label, "");
  assert.equal(validateManaged({ ...structuredClone(desired), name: actual.name }, desired, "dashboard"), actual.name);
});
test("dashboard non-default style, axis or label and content/query drift remain rejected", () => {
  const desired = dashboard();
  for (const edit of [
    (d) => { d.gridLayout.widgets[0].text.style = { textColor: "#ffffff" }; },
    (d) => { d.gridLayout.widgets[0].text.style = []; },
    (d) => { d.gridLayout.widgets[0].text.style = null; },
    ...["Y2", "TARGET_AXIS_UNSPECIFIED", "", null, 0].map((axis) => (d) => { d.gridLayout.widgets[1].xyChart.dataSets[0].targetAxis = axis; }),
    ...[PRIVATE, null, 0].map((label) => (d) => { d.gridLayout.widgets[1].xyChart.yAxis.label = label; }),
    (d) => { d.gridLayout.widgets[0].text.content = PRIVATE; },
    (d) => { d.gridLayout.widgets[1].xyChart.dataSets[0].timeSeriesQuery.prometheusQuery = "vector(0)"; },
    (d) => { d.gridLayout.widgets[1].xyChart.dataSets[0].extra = PRIVATE; },
  ]) { const actual = dashboardResponseDefaults({ ...structuredClone(desired), name: name("dashboards", "a") }); edit(actual); assert.throws(() => validateManaged(actual, desired, "dashboard")); }
});
test("dashboard drift after a normalized create stops before subsequent writes", async () => {
  const f = fake(); await f.run(true);
  f.state.dashboards[0].gridLayout.widgets[2].xyChart.dataSets[0].targetAxis = "Y2"; f.calls.length = 0;
  await assert.rejects(f.run(true), (e) => e.stage === "inventory"); assert.ok(f.calls.every((c) => c.method === "GET"));
});
for (const [title, hook] of [
  ["foreign project number", ({ u }) => u.hostname === "cloudresourcemanager.googleapis.com" ? response({ projectId: PROJECT, projectNumber: "123", lifecycleState: "ACTIVE" }) : undefined],
  ["disabled Monitoring API", ({ u }) => u.pathname.endsWith("/monitoring.googleapis.com") ? response({ name: `projects/${PROJECT_NUMBER}/services/monitoring.googleapis.com`, state: "DISABLED" }) : undefined],
  ["30h query unavailable", ({ u }) => u.pathname.endsWith("/query") ? response({ private: PRIVATE }, 400) : undefined],
  ["DELTA query result mismatch", ({ u }) => u.pathname.endsWith("/query") && !u.searchParams.get("query").includes("unless") ? response(vector(2)) : undefined],
  ["truncated raw series", ({ u }) => u.pathname.endsWith("/timeSeries") ? response({ nextPageToken: PRIVATE, timeSeries: [] }) : undefined],
  ["invalid empty fallback", ({ u }) => u.pathname.endsWith("/query") && u.searchParams.get("query").includes("unless") ? response({ status: "success", data: { resultType: "vector", result: [] } }) : undefined],
  ["incomplete raw evaluation", ({ u }) => u.pathname.endsWith("/timeSeries") ? response({ executionErrors: [{ text: PRIVATE }] }) : undefined],
]) test(`${title} fails before writes with sanitized diagnostics`, async () => {
  const f = fake({ hook }); let error; try { await f.run(true); } catch (e) { error = e; }
  assert.ok(error); assert.ok(!error.message.includes(PRIVATE)); assert.ok(f.calls.every((c) => c.method === "GET")); assert.ok(!JSON.stringify(f.logs).includes(PRIVATE));
});
test("existing extra notification destination is drift, not silently overwritten", async () => {
  const f = fake(); await f.run(true); f.state.policies[0].notificationChannels.push(name("notificationChannels", "other")); f.calls.length = 0;
  await assert.rejects(f.run(true)); assert.ok(f.calls.every((c) => c.method === "GET"));
});
test("disabled existing policy, edited query or severity is rejected", async () => {
  for (const edit of [(p) => { p.enabled = false; }, (p) => { p.conditions[0].conditionPrometheusQueryLanguage.query = "vector(0)"; }, (p) => { p.severity = "CRITICAL"; }]) {
    const f = fake(); await f.run(true); edit(f.state.policies[1]); f.calls.length = 0; await assert.rejects(f.run(true)); assert.ok(f.calls.every((c) => c.method === "GET"));
  }
});
test("name collision, duplicated resource, or foreign channel fails closed", async () => {
  for (const make of [
    (f) => { f.state.channels = [{ ...notificationChannel(EMAIL), name: channelName, type: "sms" }]; },
    (f) => { f.state.channels = [1, 2].map((i) => ({ ...notificationChannel(EMAIL), name: name("notificationChannels", String(i)) })); },
    (f) => { f.state.channels = [{ ...notificationChannel(EMAIL), name: "projects/foreign/notificationChannels/123" }]; },
  ]) { const f = fake(); make(f); await assert.rejects(f.run(true)); assert.ok(f.calls.every((c) => c.method === "GET")); }
});
test("unverified or wrong-address email channel is not treated as delivered", async () => {
  for (const row of [{ ...notificationChannel(EMAIL), verificationStatus: "UNVERIFIED" }, notificationChannel("other@example.invalid")]) {
    const f = fake(); f.state.channels = [{ ...row, name: channelName }]; await assert.rejects(f.run(true)); assert.ok(f.calls.every((c) => c.method === "GET"));
  }
});
test("unknown create response is not automatically retried", async () => {
  const f = fake({ enabled: true, hook: ({ call }) => { if (call.method === "POST") throw new Error(PRIVATE); } });
  await assert.rejects(f.run(true), (e) => e.stage === "create-channel" && !e.message.includes(PRIVATE)); assert.equal(f.calls.filter((c) => c.method === "POST").length, 1);
});
test("pagination is complete and repeated tokens never lead to a write", async () => {
  const f = fake({ hook: ({ u }) => u.pathname.endsWith("/alertPolicies") ? response({ alertPolicies: [], nextPageToken: "same" }) : undefined });
  await assert.rejects(f.run(true)); assert.ok(f.calls.every((c) => c.method === "GET"));
});
test("post-create duplicates are rejected without deleting or patching anything", async () => {
  const f = fake({ hook: ({ u, call, state }) => { if (call.method === "GET" && u.pathname.endsWith("/dashboards") && state.dashboards.length) return response({ dashboards: [state.dashboards[0], { ...state.dashboards[0], name: name("dashboards", "duplicate") }] }); } });
  await assert.rejects(f.run(true), (e) => e.stage === "verify"); assert.ok(f.calls.every((c) => ["GET", "POST"].includes(c.method)));
});
test("foreign resource names and additional arbitrary fields are rejected", () => {
  const desired = dashboard(); assert.throws(() => validateManaged({ ...desired, name: "projects/foreign/dashboards/a" }, desired, "dashboard"));
  assert.throws(() => validateManaged({ ...desired, name: name("dashboards", "a"), extra: PRIVATE }, desired, "dashboard"));
  assert.throws(() => successTotal("unrelated-job")); assert.throws(() => alertPolicy(policyDefinitions()[0], "projects/other/notificationChannels/a"));
});
test("unsafe query result shapes do not become success", () => {
  for (const body of [vector("NaN"), vector("+1"), vector("1.5"), vector("10001"), { ...vector(1), warnings: [PRIVATE] }, { ...vector(1), error: PRIVATE }, { status: "success", data: { resultType: "matrix", result: [] } }]) assert.throws(() => parsePrometheusNumber(body));
  assert.equal(parsePrometheusNumber(vector(0)), 0); assert.equal(parsePrometheusNumber(vector(1)), 1);
});
test("no hardcoded contact and input errors remain private", async () => {
  for (const email of [undefined, `${EMAIL}\n${PRIVATE}`, PRIVATE, "a@invalid"]) {
    let requests = 0; await assert.rejects(bootstrapObservability({ token: PRIVATE, email, fetchImpl: async () => { requests++; } })); assert.equal(requests, 0);
  }
  assert.equal(notificationChannel(EMAIL).labels.email_address, EMAIL); assert.ok(!JSON.stringify(plan()).includes(EMAIL)); assert.equal(OWNER, "mfmf-observability-v1");
});
test("uptime is fixed anonymous HTTPS 200, three regions and 15 minutes", () => {
  const check = uptimeCheck(); assert.equal(check.period, "900s"); assert.equal(check.timeout, "30s");
  assert.deepEqual(check.selectedRegions, ["ASIA_PACIFIC", "EUROPE", "USA_OREGON"]);
  assert.equal(check.monitoredResource.labels.host, "mfmf-candidate-wspqvmhj6q-an.a.run.app");
  assert.deepEqual(check.httpCheck, { requestMethod: "GET", useSsl: true, validateSsl: true, port: 443, path: "/login", acceptedResponseStatusCodes: [{ statusValue: 200 }] });
  const p = uptimeAlertPolicy(channelName, name("uptimeCheckConfigs", "abc")); const c = p.conditions[0].conditionThreshold;
  assert.equal(c.thresholdValue, 1); assert.equal(c.comparison, "COMPARISON_GT"); assert.equal(c.duration, "60s");
  assert.equal(c.aggregations[0].crossSeriesReducer, "REDUCE_COUNT_FALSE"); assert.ok(c.filter.includes('check_id="abc"'));
});
test("uptime target, period, auth and SSL drift cannot be adopted", () => {
  const expected = uptimeCheck();
  for (const edit of [(c) => { c.period = "60s"; }, (c) => { c.httpCheck.path = "/auth/signout"; }, (c) => { c.httpCheck.validateSsl = false; }, (c) => { c.httpCheck.authInfo = { username: PRIVATE }; }, (c) => { c.disabled = true; }]) {
    const c = structuredClone(expected); c.name = name("uptimeCheckConfigs", "abc"); edit(c); assert.throws(() => validateManaged(c, expected, "uptime"));
  }
});
test("private operational links are injected safely, never repository constants", () => {
  const d = dashboard({ billingAccountId: "ABCDEF-123456-ABCDEF", feedbackRepository: "godhuu0505/app-operations" });
  const s = d.gridLayout.widgets[0].text.content; assert.ok(s.includes(`reports;projects=${PROJECT_NUMBER}?project=${PROJECT}`)); assert.ok(s.includes("/budgets?project=")); assert.ok(s.includes("[Shared app operations (private)](https://github.com/godhuu0505/app-operations/issues)")); assert.ok(s.includes("https://sentry.io/organizations/"));
  assert.ok(d.displayName.startsWith("mfmf-")); assert.ok(policyDefinitions().every((p) => p.title.startsWith("mfmf:")));
  for (const links of [{ billingAccountId: "PRIVATE\nTOKEN" }, { feedbackRepository: "godhuu0505/mfmf" }, { feedbackRepository: "godhuu0505/repo](https://evil.invalid)" }, { feedbackRepository: "other/repo" }]) assert.throws(() => dashboard(links));
});
