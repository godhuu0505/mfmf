// Fixed-project operator bootstrap. No IAM changes, probes, application requests or secret reads.
import { pathToFileURL } from "node:url";

export const PROJECT = "mfmf-499612";
export const PROJECT_NUMBER = "92772745697";
export const REGION = "asia-northeast1";
export const JOBS = ["mfmf-identity-backup", "mfmf-db-retention"];
export const OWNER = "mfmf-observability-v1";
const MONITORING = "https://monitoring.googleapis.com";
const SERVICE = "https://serviceusage.googleapis.com/v1";
const METRIC = "run.googleapis.com/job/completed_execution_count";
const APIS = ["monitoring.googleapis.com", "logging.googleapis.com", "appoptimize.googleapis.com"];
const CHANNEL_NAME = "mfmf-operations-email-v1";
const DASHBOARD_NAME = "mfmf-production-operations-v1";
export const UPTIME_HOST = "mfmf-candidate-wspqvmhj6q-an.a.run.app";
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const canonical = (v) => Array.isArray(v) ? v.map(canonical) : object(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const need = (v) => { if (!v) throw new Error("Observability validation failed; details withheld."); };
const labels = (id) => ({ app: "mfmf", managed_by: OWNER, resource_id: id });
const ownName = (name, collection) => typeof name === "string" && new RegExp(`^projects/(${PROJECT}|${PROJECT_NUMBER})/${collection}/[A-Za-z0-9_-]{1,128}$`).test(name);
const normalizeName = (name) => name.replace(`projects/${PROJECT}/`, `projects/${PROJECT_NUMBER}/`);
const emailValid = (email) => typeof email === "string" && email.length <= 254 && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(email);

export function successTotal(job) {
  need(JOBS.includes(job));
  // This system metric is DELTA, not an application cumulative counter. Sum sparse samples directly.
  return `(sum(sum_over_time({"${METRIC}",monitored_resource="cloud_run_job",project_id="${PROJECT}",location="${REGION}",job_name="${job}",result="succeeded"}[30h])) or vector(0))`;
}
const run = (metric, extra = "") => `{"run.googleapis.com/${metric}",monitored_resource="cloud_run_revision",project_id="${PROJECT}",location="${REGION}",service_name="mfmf-candidate"${extra}}`;
const sql = (metric) => `{"cloudsql.googleapis.com/database/${metric}",monitored_resource="cloudsql_database",project_id="${PROJECT}",database_id="${PROJECT}:mfmf-db"}`;

export function policyDefinitions() {
  return [
    { id: "app-errors", title: "mfmf: application 5xx", query: `sum(sum_over_time(${run("request_count", ',response_code_class="5xx"')}[5m])) >= 3`, interval: "60s", duration: "0s", severity: "ERROR",
      help: "At least three HTTP 5xx responses in five minutes. Inspect the current Cloud Run revision and sanitized errors. No traffic does not prove availability." },
    { id: "database-down", title: "mfmf: database unavailable", query: `(max(max_over_time(${sql("up")}[5m])) or vector(0)) < 1`, interval: "60s", duration: "0s", severity: "ERROR",
      help: "Cloud SQL has no up=1 sample for five minutes. Missing telemetry also triggers this policy. Check provider health, instance state and recent changes before taking action." },
    { id: "database-storage", title: "mfmf: database storage pressure", query: `max(${sql("disk/utilization")}) > 0.8`, interval: "60s", duration: "900s", severity: "WARNING",
      help: "Cloud SQL disk utilization exceeds 80% for fifteen minutes. Inspect growth and the storage limit; preserve recovery quality and do not delete records automatically." },
    { id: "backup-failed", title: "mfmf: backup job failed", query: `sum by (job_name) (sum_over_time({"${METRIC}",monitored_resource="cloud_run_job",project_id="${PROJECT}",location="${REGION}",job_name=~"mfmf-(identity-backup|db-retention)",result!="succeeded"}[20m])) > 0`, interval: "60s", duration: "0s", severity: "ERROR",
      help: "A fixed backup job finished unsuccessfully or was cancelled. Read the execution and sanitized stage. Do not blindly rerun a mutation with an unknown outcome." },
    ...JOBS.map((job, i) => ({ id: i ? "retention-stale" : "identity-stale", title: `mfmf: ${job} no success for 30h`, query: `${successTotal(job)} < 1`, interval: "300s", duration: "0s", severity: "ERROR",
      help: "No successful execution in thirty hours, including an empty time series. Check Scheduler and Job status. A successful execution is not independent decryption or restoration proof. This policy uses the standard-metric extended PromQL lookback Preview; review its availability and cost before September 2027." })),
  ];
}

export function alertPolicy(definition, channel) {
  need(policyDefinitions().some((d) => same(d, definition)) && ownName(channel, "notificationChannels"));
  return { displayName: definition.title, userLabels: labels(definition.id), enabled: true, combiner: "OR", severity: definition.severity,
    documentation: { mimeType: "text/markdown", content: `${definition.help}\n\nRunbook: https://github.com/godhuu0505/mfmf/blob/main/docs/guides/gcp-observability.md` },
    conditions: [{ displayName: definition.id, conditionPrometheusQueryLanguage: { query: definition.query, duration: definition.duration, evaluationInterval: definition.interval } }],
    notificationChannels: [channel], alertStrategy: { autoClose: "604800s", notificationChannelStrategy: [{ notificationChannelNames: [channel], renotifyInterval: "21600s" }] } };
}
export function notificationChannel(email) {
  need(emailValid(email));
  return { type: "email", displayName: CHANNEL_NAME, enabled: true, labels: { email_address: email }, userLabels: labels("email") };
}
export function uptimeCheck() {
  return { displayName: "mfmf-public-login-v1", userLabels: labels("uptime"), period: "900s", timeout: "30s", checkerType: "STATIC_IP_CHECKERS", disabled: false,
    selectedRegions: ["ASIA_PACIFIC", "EUROPE", "USA_OREGON"], logCheckFailures: false,
    monitoredResource: { type: "uptime_url", labels: { project_id: PROJECT, host: UPTIME_HOST } },
    httpCheck: { requestMethod: "GET", useSsl: true, validateSsl: true, port: 443, path: "/login", acceptedResponseStatusCodes: [{ statusValue: 200 }] } };
}
export function uptimeAlertPolicy(channel, check) {
  need(ownName(channel, "notificationChannels") && ownName(check, "uptimeCheckConfigs"));
  return { displayName: "mfmf: public login unreachable", userLabels: labels("uptime-failed"), enabled: true, combiner: "OR", severity: "ERROR",
    documentation: { mimeType: "text/markdown", content: "At least two of three external checkers report failure. Check TLS, Cloud Run and provider health. The public login check does not prove authenticated DB access. Runbook: https://github.com/godhuu0505/mfmf/blob/main/docs/guides/gcp-observability.md" },
    conditions: [{ displayName: "uptime-failed", conditionThreshold: {
      filter: `metric.type="monitoring.googleapis.com/uptime_check/check_passed" AND resource.type="uptime_url" AND metric.labels.check_id="${check.split("/").at(-1)}" AND resource.labels.host="${UPTIME_HOST}"`,
      aggregations: [{ alignmentPeriod: "1200s", perSeriesAligner: "ALIGN_NEXT_OLDER", crossSeriesReducer: "REDUCE_COUNT_FALSE", groupByFields: ["resource.label.host"] }],
      comparison: "COMPARISON_GT", thresholdValue: 1, duration: "60s", trigger: { count: 1 } } }],
    notificationChannels: [channel], alertStrategy: { autoClose: "604800s", notificationChannelStrategy: [{ notificationChannelNames: [channel], renotifyInterval: "21600s" }] } };
}
export function dashboard({ billingAccountId, feedbackRepository } = {}) {
  need(billingAccountId === undefined || typeof billingAccountId === "string" && /^[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{6}$/.test(billingAccountId));
  need(feedbackRepository === undefined || typeof feedbackRepository === "string" && /^godhuu0505\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(feedbackRepository) && feedbackRepository !== "godhuu0505/mfmf");
  const report = billingAccountId ? `https://console.cloud.google.com/billing/${billingAccountId}/reports;projects=${PROJECT_NUMBER}?project=${PROJECT}` : `https://console.cloud.google.com/billing?project=${PROJECT}`;
  const budget = billingAccountId ? `https://console.cloud.google.com/billing/${billingAccountId}/budgets?project=${PROJECT}` : `https://console.cloud.google.com/billing?project=${PROJECT}`;
  const feedback = feedbackRepository ? ` · [Shared app operations (private)](https://github.com/${feedbackRepository}/issues)` : "";
  const chart = (title, query) => ({ title, xyChart: { dataSets: [{ timeSeriesQuery: { prometheusQuery: query }, plotType: "LINE", minAlignmentPeriod: "60s" }], yAxis: { label: "", scale: "LINEAR" }, chartOptions: { mode: "COLOR" } } });
  return { displayName: DASHBOARD_NAME, labels: labels("dashboard"), gridLayout: { columns: "2", widgets: [
    { title: "Operations and costs", text: { format: "MARKDOWN", content: `[Cloud Hub](https://console.cloud.google.com/cloud-hub?project=${PROJECT}) · [Costs and utilization](https://console.cloud.google.com/cloud-hub/optimization?project=${PROJECT}) · [Project cost report](${report}) · [Budget](${budget})${feedback} · [Sentry](https://sentry.io/organizations/)\n\nBilling is linked, not copied into metrics. Costs are delayed and credits are separate; the budget is not a spending cap. [Runbook](https://github.com/godhuu0505/mfmf/blob/main/docs/guides/gcp-observability.md). Uptime checks issue unauthenticated GET /login requests. A job success does not prove restoration.` } },
    chart("Application requests / 5 minutes", `sum(sum_over_time(${run("request_count")}[5m])) or vector(0)`),
    chart("Application 5xx / 5 minutes", `sum(sum_over_time(${run("request_count", ',response_code_class="5xx"')}[5m])) or vector(0)`),
    chart("Database up (1=up)", `max(${sql("up")})`),
    chart("Database disk utilization (0-1)", `max(${sql("disk/utilization")})`),
    chart("Database CPU utilization (0-1)", `max(${sql("cpu/utilization")})`),
    ...JOBS.map((job) => chart(`${job}: successes / 30 hours`, successTotal(job))),
  ] } };
}
export function plan() {
  return { project: PROJECT, projectNumber: PROJECT_NUMBER, cloudHub: "project", optionalApiToEnable: "appoptimize.googleapis.com", dashboards: 1, emailChannels: 1,
    policies: [...policyDefinitions().map(({ id, interval }) => ({ id, evaluationInterval: interval })), { id: "uptime-failed" }], absenceHours: 30, extendedLookbackPreview: true,
    iamChanges: false, applicationRequests: "uptime GET /login only", customMetrics: false, uptimeChecks: 1, uptimePeriodSeconds: 900, uptimeRegions: 3, bigQuery: false, feesMustBeReviewedBefore: "2027-09-01" };
}

// Drop only documented output fields and harmless omitted protobuf defaults; no broad projection
// that could hide additional channels, conditions, queries or resource targets.
function shape(actual, kind) {
  const value = structuredClone(actual);
  delete value.name; delete value.etag; delete value.creationRecord; delete value.mutationRecord; delete value.mutationRecords;
  if (kind === "channel") { need(value.verificationStatus !== "UNVERIFIED"); delete value.verificationStatus; }
  if (kind === "uptime") {
    value.disabled ??= false; value.logCheckFailures ??= false;
    if (value.isInternal === false) delete value.isInternal;
    if (value.httpCheck?.maskHeaders === false) delete value.httpCheck.maskHeaders;
    value.selectedRegions?.sort();
  }
  if (kind === "dashboard") {
    // Dashboard API materializes these exact defaults and omits empty string labels.
    // Preserve every non-default value so content, query and rendering drift still fails.
    for (const widget of value.gridLayout?.widgets ?? []) {
      if (object(widget.text?.style) && Object.keys(widget.text.style).length === 0) delete widget.text.style;
      if (widget.xyChart?.yAxis?.label === "") delete widget.xyChart.yAxis.label;
      for (const dataSet of widget.xyChart?.dataSets ?? []) if (dataSet.targetAxis === "Y1") delete dataSet.targetAxis;
    }
  }
  if (kind === "policy") {
    need(!value.validity || (value.validity.code ?? 0) === 0); delete value.validity;
    for (const c of value.conditions ?? []) { delete c.name; if (c.conditionPrometheusQueryLanguage?.disableMetricValidation === false) delete c.conditionPrometheusQueryLanguage.disableMetricValidation; }
    value.notificationChannels = value.notificationChannels?.map(normalizeName);
    for (const s of value.alertStrategy?.notificationChannelStrategy ?? []) s.notificationChannelNames = s.notificationChannelNames?.map(normalizeName);
  }
  return canonical(value);
}
export function validateManaged(actual, desired, kind) {
  const collection = { channel: "notificationChannels", policy: "alertPolicies", dashboard: "dashboards", uptime: "uptimeCheckConfigs" }[kind];
  need(collection && ownName(actual?.name, collection) && same(shape(actual, kind), shape(desired, kind)));
  return actual.name;
}

export function parsePrometheusNumber(body) {
  need(body?.status === "success" && !body.error && !body.warnings?.length && body.data?.resultType === "vector" && Array.isArray(body.data.result) && body.data.result.length === 1);
  const r = body.data.result[0]; need(object(r.metric) && Object.keys(r.metric).length === 0 && Array.isArray(r.value) && r.value.length === 2 && Number.isFinite(r.value[0]) && typeof r.value[1] === "string" && /^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(r.value[1]));
  const n = Number(r.value[1]); need(Number.isSafeInteger(n) && n >= 0 && n <= 10000); return n;
}

export async function bootstrapObservability({ token, email, links = {}, apply = false, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, log = console.log }) {
  need(typeof token === "string" && token.length > 0 && token.length <= 16384 && !/[\r\n]/.test(token));
  need(emailValid(email) && typeof apply === "boolean");
  const dashboardDesired = dashboard(links);
  let stage = "project";
  const request = async (url, { method = "GET", body } = {}) => {
    need(method === "GET" || apply && method === "POST");
    let response;
    try { response = await fetchImpl(url, { method, headers: { Authorization: `Bearer ${token}`, "X-Goog-User-Project": PROJECT, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: "error", signal: AbortSignal.timeout(30000) }); }
    catch { throw new Error("Request failed; details withheld."); }
    if (!response.ok) { try { await response.body?.cancel(); } catch { /* never expose response */ } const error = new Error("Request failed; details withheld."); error.httpStatus = response.status; throw error; }
    try { let size = 0; const chunks = []; for await (const p of response.body) { size += p.length; need(size <= 2 * 1024 * 1024); chunks.push(Buffer.from(p)); } return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw new Error("Response rejected; details withheld."); }
  };
  const list = async (collection, version, field) => {
    let pageToken; const seen = new Set(), all = [];
    for (let page = 0; page < 10; page++) {
      const url = new URL(`${MONITORING}/${version}/projects/${PROJECT}/${collection}`); url.searchParams.set("pageSize", "100"); if (pageToken) url.searchParams.set("pageToken", pageToken);
      const response = await request(url.href); const rows = response[field] ?? []; need(Array.isArray(rows)); all.push(...rows); need(all.length <= 1000);
      if (!response.nextPageToken) return all;
      need(typeof response.nextPageToken === "string" && response.nextPageToken.length <= 2048 && !seen.has(response.nextPageToken)); pageToken = response.nextPageToken; seen.add(pageToken);
    }
    need(false);
  };
  const managed = (all, desired) => {
    const wantedLabels = desired.userLabels ?? desired.labels;
    const matches = all.filter((a) => a.displayName === desired.displayName || (a.userLabels ?? a.labels)?.managed_by === OWNER && (a.userLabels ?? a.labels)?.resource_id === wantedLabels.resource_id);
    need(matches.length <= 1); return matches[0];
  };
  const prometheus = async (query, time) => {
    const url = new URL(`${MONITORING}/v1/projects/${PROJECT}/location/global/prometheus/api/v1/query`); url.searchParams.set("query", query); url.searchParams.set("time", String(time / 1000));
    return parsePrometheusNumber(await request(url.href));
  };
  try {
    const project = await request(`https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT}`);
    need(project?.projectId === PROJECT && project.projectNumber === PROJECT_NUMBER && project.lifecycleState === "ACTIVE");
    stage = "apis"; const states = new Map();
    for (const api of APIS) { const v = await request(`${SERVICE}/projects/${PROJECT_NUMBER}/services/${api}?fields=name,state`); need(v.name === `projects/${PROJECT_NUMBER}/services/${api}` && ["ENABLED", "DISABLED"].includes(v.state)); need(api === "appoptimize.googleapis.com" || v.state === "ENABLED"); states.set(api, v.state); }
    stage = "inventory";
    const channels = await list("notificationChannels", "v3", "notificationChannels"); const policies = await list("alertPolicies", "v3", "alertPolicies"); const dashboards = await list("dashboards", "v1", "dashboards");
    const uptimeDesired = uptimeCheck(); let uptime = managed(await list("uptimeCheckConfigs", "v3", "uptimeCheckConfigs"), uptimeDesired);
    if (uptime) validateManaged(uptime, uptimeDesired, "uptime");
    const channelDesired = notificationChannel(email);
    let channel = managed(channels, channelDesired); const board = managed(dashboards, dashboardDesired);
    if (channel) validateManaged(channel, channelDesired, "channel"); if (board) validateManaged(board, dashboardDesired, "dashboard");
    const definitions = policyDefinitions();
    for (const p of policies) if (p.userLabels?.managed_by === OWNER) need(p.userLabels.resource_id === "uptime-failed" || definitions.some((d) => d.id === p.userLabels.resource_id));
    const externalDesired = uptimeAlertPolicy(channel?.name ?? `projects/${PROJECT}/notificationChannels/placeholder`, uptime?.name ?? `projects/${PROJECT}/uptimeCheckConfigs/placeholder`);
    const externalPolicy = managed(policies, externalDesired); if (externalPolicy) { need(channel && uptime); validateManaged(externalPolicy, externalDesired, "policy"); }
    const current = new Map();
    for (const d of definitions) {
      const wanted = alertPolicy(d, channel?.name ?? `projects/${PROJECT}/notificationChannels/placeholder`), p = managed(policies, wanted);
      if (p) { need(channel); validateManaged(p, wanted, "policy"); } current.set(d.id, p);
    }
    stage = "queries";
    const time = now(); need(Number.isSafeInteger(time) && time > 0); const successCounts = [];
    for (const job of JOBS) {
      // Compare sparse DELTA source values with the exact 30h expression used by the policy.
      const url = new URL(`${MONITORING}/v3/projects/${PROJECT}/timeSeries`);
      url.searchParams.set("filter", `metric.type="${METRIC}" AND resource.type="cloud_run_job" AND resource.labels.project_id="${PROJECT}" AND resource.labels.location="${REGION}" AND resource.labels.job_name="${job}" AND metric.labels.result="succeeded"`);
      url.searchParams.set("interval.startTime", new Date(time - 30 * 3600000).toISOString()); url.searchParams.set("interval.endTime", new Date(time).toISOString()); url.searchParams.set("pageSize", "10000");
      const raw = await request(url.href); need(!raw.nextPageToken && !raw.executionErrors?.length && (!raw.timeSeries || Array.isArray(raw.timeSeries)));
      let total = 0;
      for (const series of raw.timeSeries ?? []) {
        need(series.metricKind === "DELTA" && series.valueType === "INT64" && series.metric?.type === METRIC && series.metric.labels?.result === "succeeded"
          && series.resource?.type === "cloud_run_job" && series.resource.labels?.project_id === PROJECT && series.resource.labels?.location === REGION && series.resource.labels?.job_name === job && Array.isArray(series.points));
        for (const p of series.points) { need(typeof p.value?.int64Value === "string" && /^(0|[1-9][0-9]*)$/.test(p.value.int64Value)); total += Number(p.value.int64Value); need(Number.isSafeInteger(total) && total <= 10000); }
      }
      need(await prometheus(successTotal(job), time) === total);
      // Empty-vector fallback must fire (one result with value 0), not disappear silently.
      need(await prometheus(`((${successTotal(job)} unless on() vector(0)) or vector(0)) < 1`, time) === 0);
      successCounts.push(total);
    }
    const changes = { api: states.get("appoptimize.googleapis.com") === "DISABLED" ? 1 : 0, channel: channel ? 0 : 1, dashboard: board ? 0 : 1, uptime: uptime ? 0 : 1, policies: definitions.filter((d) => !current.get(d.id)).length + (externalPolicy ? 0 : 1) };
    if (!apply) { const result = { mode: "inspect", ...plan(), changes, successCounts, queryProof: true, applied: false }; log(JSON.stringify(result)); return result; }
    if (changes.api) {
      stage = "enable-hub";
      let op = await request(`${SERVICE}/projects/${PROJECT_NUMBER}/services/appoptimize.googleapis.com:enable`, { method: "POST", body: {} });
      need(typeof op.name === "string" && /^operations\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(op.name) && op.name.length <= 256); const name = op.name;
      for (let i = 0; op.done !== true && i < 60; i++) { await sleep(1000); op = await request(`${SERVICE}/${name}`); need(op.name === name && !op.error); }
      need(op.done === true && !op.error);
    }
    if (!channel) {
      stage = "create-channel"; need(!managed(await list("notificationChannels", "v3", "notificationChannels"), channelDesired));
      channel = await request(`${MONITORING}/v3/projects/${PROJECT}/notificationChannels`, { method: "POST", body: channelDesired }); validateManaged(channel, channelDesired, "channel");
    }
    if (!uptime) {
      stage = "create-uptime"; need(!managed(await list("uptimeCheckConfigs", "v3", "uptimeCheckConfigs"), uptimeDesired));
      uptime = await request(`${MONITORING}/v3/projects/${PROJECT}/uptimeCheckConfigs`, { method: "POST", body: uptimeDesired }); validateManaged(uptime, uptimeDesired, "uptime");
    }
    if (!externalPolicy) {
      stage = "create-policy"; const desired = uptimeAlertPolicy(channel.name, uptime.name); need(!managed(await list("alertPolicies", "v3", "alertPolicies"), desired));
      validateManaged(await request(`${MONITORING}/v3/projects/${PROJECT}/alertPolicies`, { method: "POST", body: desired }), desired, "policy");
    }
    for (const d of definitions) if (!current.get(d.id)) {
      stage = "create-policy"; const desired = alertPolicy(d, channel.name);
      need(!managed(await list("alertPolicies", "v3", "alertPolicies"), desired));
      validateManaged(await request(`${MONITORING}/v3/projects/${PROJECT}/alertPolicies`, { method: "POST", body: desired }), desired, "policy");
    }
    if (!board) {
      stage = "create-dashboard"; need(!managed(await list("dashboards", "v1", "dashboards"), dashboardDesired));
      validateManaged(await request(`${MONITORING}/v1/projects/${PROJECT}/dashboards`, { method: "POST", body: dashboardDesired }), dashboardDesired, "dashboard");
    }
    stage = "verify";
    need((await request(`${SERVICE}/projects/${PROJECT_NUMBER}/services/appoptimize.googleapis.com?fields=name,state`)).state === "ENABLED");
    validateManaged(managed(await list("notificationChannels", "v3", "notificationChannels"), channelDesired), channelDesired, "channel");
    const finalPolicies = await list("alertPolicies", "v3", "alertPolicies");
    for (const d of definitions) { const desired = alertPolicy(d, channel.name); validateManaged(managed(finalPolicies, desired), desired, "policy"); }
    validateManaged(managed(await list("dashboards", "v1", "dashboards"), dashboardDesired), dashboardDesired, "dashboard");
    validateManaged(managed(await list("uptimeCheckConfigs", "v3", "uptimeCheckConfigs"), uptimeDesired), uptimeDesired, "uptime");
    const finalExternal = uptimeAlertPolicy(channel.name, uptime.name); validateManaged(managed(finalPolicies, finalExternal), finalExternal, "policy");
    const result = { mode: "apply", verified: true, changes, successCounts, policies: definitions.length + 1, dashboard: 1, uptimeChecks: 1, emailChannels: 1, notificationDeliveryVerified: false, cloudHubUiVerified: false, uptimeReachabilityVerified: false };
    log(JSON.stringify(result)); return result;
  } catch (error) {
    const safe = new Error("Observability bootstrap stopped; inspect current state before retrying. Details withheld."); safe.stage = stage;
    if (Number.isInteger(error?.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599) safe.httpStatus = error.httpStatus;
    throw safe;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || same(args, ["--plan"])) { console.log(JSON.stringify(plan())); return; }
  need(args.length === 1 && ["--inspect", "--apply"].includes(args[0]));
  await bootstrapObservability({ token: process.env.GCP_ACCESS_TOKEN, email: process.env.MFMF_ALERT_EMAIL,
    links: { billingAccountId: process.env.MFMF_BILLING_ACCOUNT_ID, feedbackRepository: process.env.MFMF_PRIVATE_FEEDBACK_REPOSITORY }, apply: args[0] === "--apply" });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => {
  console.error(JSON.stringify({ status: "stopped", stage: error?.stage ?? "input", ...(error?.httpStatus ? { httpStatus: error.httpStatus } : {}), details: "withheld" })); process.exitCode = 1;
});
