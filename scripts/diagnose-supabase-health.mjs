import { pathToFileURL } from "node:url";

// Read-only comparison of documented query forms. Never import/call restore code.
// Public OpenAPI: https://api.supabase.com/api/v1
// Supabase's own E2E uses CSV without timeout_ms:
// https://github.com/supabase/supabase/blob/master/e2e/studio/scripts/common/wait-healthy-services.ts
const SERVICES = ["db", "auth", "rest", "storage"];
const SERVICE_NAMES = new Set([...SERVICES, "db_postgres_user", "pooler", "realtime", "pg_bouncer"]);
const SERVICE_STATUSES = new Set(["COMING_UP", "ACTIVE_HEALTHY", "UNHEALTHY"]);
const PROJECT_STATUSES = new Set([
  "INACTIVE", "ACTIVE_HEALTHY", "ACTIVE_UNHEALTHY", "COMING_UP", "UNKNOWN",
  "GOING_DOWN", "INIT_FAILED", "REMOVED", "RESTORING", "UPGRADING", "PAUSING",
  "RESTORE_FAILED", "RESTARTING", "PAUSE_FAILED", "RESIZING",
]);
const PARAMS = ["services", "timeout_ms", "ref"];
const VALIDATION_CODES = new Set([
  "invalid_type", "invalid_value", "invalid_enum_value", "invalid_union",
  "unrecognized_keys", "too_small", "too_big", "required",
]);
const MAX_BODY_BYTES = 32_768;
class DiagnosticError extends Error {}

/** Return only fixed vocabulary. Never return API messages, values, paths or keys. */
export function classifyValidation(body) {
  const parameters = new Set();
  const codes = new Set();
  function visit(value, depth = 0) {
    if (depth > 6 || value == null) return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 50)) visit(item, depth + 1);
    } else if (typeof value === "object") {
      if (Array.isArray(value.path)) {
        for (const part of value.path) if (PARAMS.includes(part)) parameters.add(part);
      }
      if (PARAMS.includes(value.property)) parameters.add(value.property);
      if (VALIDATION_CODES.has(value.code)) codes.add(value.code);
      for (const key of ["issues", "errors", "error", "message", "details", "constraints"]) {
        if (key === "constraints" && typeof value[key] === "object" && value[key] !== null) {
          for (const message of Object.values(value[key]).slice(0, 20)) visit(message, depth + 1);
        } else visit(value[key], depth + 1);
      }
    } else if (typeof value === "string") {
      // Nest/class-validator sometimes returns an array of message strings.
      const message = value.slice(0, 4096);
      for (const name of PARAMS) if (new RegExp(`\\b${name}\\b`).test(message)) parameters.add(name);
      if (/expected (number|string|array|integer)|must be (an? )?(number|string|array|integer)/i.test(message)) codes.add("invalid_type");
      if (/is required|should not be empty/i.test(message)) codes.add("required");
    }
  }
  visit(body);
  return { parameters: PARAMS.filter((name) => parameters.has(name)), codes: [...codes].sort() };
}

async function limitedJson(response) {
  const reader = response.body?.getReader();
  if (!reader) return { kind: "invalid-json" };
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        return { kind: "body-too-large" };
      }
      chunks.push(value);
    }
    try {
      return { kind: "json", value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
    } catch { return { kind: "invalid-json" }; }
  } catch { return { kind: "body-read-failed" }; }
  finally { reader.releaseLock(); }
}

function probes() {
  const repeated = new URLSearchParams(SERVICES.map((name) => ["services", name]));
  const current = new URLSearchParams(repeated);
  current.set("timeout_ms", "5000");
  return [
    { name: "repeated-with-timeout", query: current, services: SERVICES },
    { name: "repeated-default-timeout", query: repeated, services: SERVICES },
    { name: "csv-default-timeout", query: new URLSearchParams({ services: SERVICES.join(",") }), services: SERVICES },
    ...SERVICES.map((name) => ({ name: `single-${name}`, query: new URLSearchParams({ services: name }), services: [name] })),
  ];
}

function summarizeServices(body, requested) {
  if (!Array.isArray(body) || body.some((item) => !item || !SERVICE_NAMES.has(item.name) || !SERVICE_STATUSES.has(item.status))) {
    return { outcome: "unexpected-schema" };
  }
  const services = {};
  for (const name of requested) {
    const matches = body.filter((item) => item.name === name);
    if (matches.length !== 1) return { outcome: "missing-or-duplicate-service" };
    services[name] = matches[0].status;
  }
  return { outcome: Object.values(services).every((status) => status === "ACTIVE_HEALTHY") ? "healthy" : "not-healthy", services };
}

export async function diagnoseProject({ token, projectRef, fetchImpl = fetch, log = console.log }) {
  if (!token || /[\r\n]/.test(token) || !/^[a-z]{20}$/.test(projectRef ?? "")) {
    throw new DiagnosticError("Required Supabase secrets are missing or invalid.");
  }
  const base = `https://api.supabase.com/v1/projects/${projectRef}`;
  async function get(path) {
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method: "GET", headers: { Authorization: `Bearer ${token}` },
        redirect: "error", signal: AbortSignal.timeout(15_000),
      });
    } catch { return { outcome: "network-or-timeout" }; }
    const body = await limitedJson(response);
    if (!response.ok) {
      return { httpStatus: response.status, outcome: "http-error", bodyKind: body.kind,
        validation: body.kind === "json" ? classifyValidation(body.value) : { parameters: [], codes: [] } };
    }
    if (body.kind !== "json") return { httpStatus: response.status, outcome: body.kind };
    return { httpStatus: response.status, body: body.value };
  }
  const project = await get("");
  const validProject = project.body?.ref === projectRef && PROJECT_STATUSES.has(project.body?.status);
  const projectReady = validProject && project.body.status === "ACTIVE_HEALTHY";
  const projectResult = "body" in project
    ? { httpStatus: project.httpStatus, outcome: validProject ? (projectReady ? "ready" : "not-ready") : "unexpected-project",
        ...(validProject ? { status: project.body.status } : {}) }
    : project;
  log(JSON.stringify({ probe: "project-status", ...projectResult }));
  if (!projectReady) {
    return { projectReady: false, allServicesHealthy: false, allQueriesAccepted: false, probes: [] };
  }

  const results = [];
  // Eight GETs maximum including project status. No retries or format fallback loops.
  for (const probe of probes()) {
    const response = await get(`/health?${probe.query}`);
    const result = "body" in response
      ? { probe: probe.name, httpStatus: response.httpStatus, ...summarizeServices(response.body, probe.services) }
      : { probe: probe.name, ...response };
    results.push(result);
    log(JSON.stringify(result));
  }
  const fullCheckHealthy = results.some((result) => result.outcome === "healthy" && Object.keys(result.services).length === SERVICES.length);
  const individualChecksHealthy = SERVICES.every((name) => results.some((result) => result.probe === `single-${name}` && result.outcome === "healthy"));
  const summary = { projectReady: true, allServicesHealthy: fullCheckHealthy || individualChecksHealthy,
    allQueriesAccepted: results.every((result) => result.httpStatus === 200), probes: results };
  log(JSON.stringify({ summary: { allServicesHealthy: summary.allServicesHealthy, allQueriesAccepted: summary.allQueriesAccepted }, operation: "GET-only" }));
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_REF !== "refs/heads/main" || process.env.GITHUB_EVENT_NAME !== "workflow_dispatch") {
    console.error("Health diagnosis requires a manual main workflow run.");
    process.exitCode = 1;
  } else {
    diagnoseProject({ token: process.env.SUPABASE_ACCESS_TOKEN, projectRef: process.env.SUPABASE_PROJECT_ID })
      .then((result) => { if (!result.allServicesHealthy) process.exitCode = 1; })
      .catch((error) => {
        console.error(error instanceof DiagnosticError ? error.message : "Health diagnosis failed; details withheld.");
        process.exitCode = 1;
      });
  }
}
