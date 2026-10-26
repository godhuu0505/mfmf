import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parsePreseededSecretVersions, prepareWithDocker, selectProductionConfig, SECRET_NAMES } from "./prepare-candidate.mjs";
import { PROJECT, PROJECT_NUMBER, REGION, SERVICE, RUNTIME, SERVICE_NAME, PUBLIC_ORIGIN, IMAGE_BASE, requireContinuousContext } from "./production-config.mjs";

const API = `https://run.googleapis.com/v2/${SERVICE_NAME}`;
const REVISION_TYPE = "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION";
const LATEST_TYPE = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST";
const PIN_KEYS = ["TOKEN_ENC_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"];
const PUBLIC_KEYS = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SIGNUP_ENABLED", "SENTRY_ENVIRONMENT", "SENTRY_TRACES_SAMPLE_RATE"];
class DeploymentError extends Error {}
const fail = (message) => { throw new DeploymentError(message); };
const exactKeys = (object, keys) => object && typeof object === "object" && !Array.isArray(object) &&
  Object.keys(object).length === keys.length && keys.every((key) => Object.hasOwn(object, key));
const revisionName = (name) => typeof name === "string" && /^mfmf-candidate-[a-z0-9-]{1,48}$/.test(name);
const shortRevision = (value) => typeof value === "string" && value.startsWith(`${SERVICE_NAME}/revisions/`) ? value.slice(`${SERVICE_NAME}/revisions/`.length) : value;
const succeeded = (condition) => condition?.state === "CONDITION_SUCCEEDED";
const imageDigest = (value) => typeof value === "string" && value.startsWith(`${IMAGE_BASE}@sha256:`) && /^[a-f0-9]{64}$/.test(value.slice(`${IMAGE_BASE}@sha256:`.length));

export function validateFixedVersions(text, env) {
  const refs = parsePreseededSecretVersions({ ...env, PRESEEDED_SECRET_VERSIONS: text });
  if (!exactKeys(refs, PIN_KEYS) || Object.values(refs).some((ref) => !ref.startsWith(`projects/${PROJECT_NUMBER}/`))) {
    fail("Committed secret references must contain the three fixed project-number references.");
  }
  return refs;
}

export function validateManifest(manifest, pins, env) {
  if (!exactKeys(manifest, ["image", "region", "service", "env", "features", "secretVersions"]) ||
      !imageDigest(manifest.image) || manifest.region !== REGION || manifest.service !== SERVICE ||
      !exactKeys(manifest.env, PUBLIC_KEYS) || !exactKeys(manifest.features, ["googleDriveConfigured", "sentryConfigured"]) ||
      !manifest.secretVersions || typeof manifest.secretVersions !== "object" || Array.isArray(manifest.secretVersions)) {
    fail("Candidate public manifest is invalid; contents withheld.");
  }
  for (const key of PIN_KEYS) if (manifest.secretVersions[key] !== pins[key]) fail("Candidate changed a committed secret reference.");
  for (const [key, ref] of Object.entries(manifest.secretVersions)) {
    if (!Object.hasOwn(SECRET_NAMES, key) || typeof ref !== "string" ||
        !new RegExp(`^projects/(${PROJECT}|${PROJECT_NUMBER})/secrets/${SECRET_NAMES[key]}/versions/[1-9][0-9]*$`).test(ref)) {
      fail("Candidate secret reference is invalid.");
    }
  }
  // Reuse the source setting validation without manufacturing or reading server secret values.
  const entries = Object.entries(manifest.env).map(([key, value]) => ({ key, value, target: ["production"], type: "plain" }));
  entries.push(...PIN_KEYS.map((key) => ({ key, target: ["production"], type: "sensitive" })));
  const checked = selectProductionConfig({ envs: entries }, pins);
  if (PUBLIC_KEYS.some((key) => checked.publicEnv[key] !== manifest.env[key]) ||
      manifest.features.googleDriveConfigured !== true ||
      manifest.features.sentryConfigured !== Object.hasOwn(manifest.secretVersions, "SENTRY_DSN") ||
      env.GCP_PROJECT_ID !== PROJECT) fail("Candidate configuration does not match the validated source.");
}

function validateService(service) {
  const template = service?.template;
  const container = template?.containers?.[0];
  if (service?.name !== SERVICE_NAME || service.uri !== PUBLIC_ORIGIN ||
      typeof service.uid !== "string" || !service.uid || typeof service.etag !== "string" || !service.etag ||
      service.deleteTime || service.defaultUriDisabled === true || service.iapEnabled === true || service.buildConfig ||
      (service.scaling?.minInstanceCount ?? 0) !== 0 || service.scaling?.maxInstanceCount !== 1 ||
      ![undefined, "AUTOMATIC"].includes(service.scaling?.scalingMode) ||
      (template?.scaling?.minInstanceCount ?? 0) !== 0 || template?.scaling?.maxInstanceCount !== 1 ||
      template?.serviceAccount !== RUNTIME || template.executionEnvironment !== "EXECUTION_ENVIRONMENT_GEN2" ||
      template.maxInstanceRequestConcurrency !== 10 || template.timeout !== "60s" ||
      template.vpcAccess || template.volumes?.length || template.healthCheckDisabled === true ||
      !Array.isArray(template.containers) || template.containers.length !== 1 || !imageDigest(container?.image) ||
      container.resources?.limits?.cpu !== "1" || container.resources?.limits?.memory !== "512Mi" ||
      Object.keys(container.resources?.limits ?? {}).length !== 2 || container.resources?.cpuIdle !== true ||
      !Array.isArray(container.ports) || container.ports.length !== 1 || container.ports[0].containerPort !== 8080 ||
      container.ports[0].name !== "http1" || container.command?.length || container.args?.length ||
      container.volumeMounts?.length || container.sourceCode || container.baseImageUri) {
    fail("Existing service identity or runtime constraints differ; no service was created or reconfigured.");
  }
  const seen = new Set();
  for (const item of container.env ?? []) {
    if (!item || seen.has(item.name) || ![...PUBLIC_KEYS, ...Object.keys(SECRET_NAMES)].includes(item.name)) {
      fail("Existing runtime has duplicate or unmanaged environment settings.");
    }
    seen.add(item.name);
    if (Object.hasOwn(SECRET_NAMES, item.name) && (Object.hasOwn(item, "value") || !item.valueSource?.secretKeyRef)) {
      fail("Existing server settings must use secret references.");
    }
  }
  return container;
}

function assertReady(service) {
  if (service.reconciling === true || !succeeded(service.terminalCondition) ||
      typeof service.generation !== "string" || service.generation !== service.observedGeneration) fail("Cloud Run is not ready and reconciled.");
}

function trafficIs(targets, revision, allowLatest = false) {
  return Array.isArray(targets) && targets.length === 1 && targets[0].percent === 100 && !targets[0].tag &&
    ((targets[0].type === REVISION_TYPE && shortRevision(targets[0].revision) === revision) ||
      (allowLatest && targets[0].type === LATEST_TYPE && (!targets[0].revision || shortRevision(targets[0].revision) === revision)));
}

function runtimeEnvMatches(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  const normalized = (items) => items.map((item) => {
    if (!item || typeof item.name !== "string") return null;
    if (Object.hasOwn(item, "valueSource")) {
      if (!exactKeys(item, ["name", "valueSource"]) || !exactKeys(item.valueSource, ["secretKeyRef"]) ||
          !exactKeys(item.valueSource.secretKeyRef, ["secret", "version"])) return null;
      const ref = item.valueSource.secretKeyRef;
      // API may canonicalize a same-project short secret name into its full resource name.
      const secret = typeof ref.secret === "string" ? ref.secret.replace(new RegExp(`^projects/(${PROJECT}|${PROJECT_NUMBER})/secrets/`), "") : null;
      return [item.name, secret, ref.version];
    }
    return exactKeys(item, ["name", "value"]) ? [item.name, item.value] : null;
  });
  const left = normalized(actual); const right = normalized(expected);
  if (left.some((item) => item === null)) return false;
  return JSON.stringify(left.sort((a, b) => a[0].localeCompare(b[0]))) === JSON.stringify(right.sort((a, b) => a[0].localeCompare(b[0])));
}

async function api(fetchImpl, token, url = API, patch) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: patch ? "PATCH" : "GET", headers: { Authorization: `Bearer ${token}`, ...(patch ? { "Content-Type": "application/json" } : {}) },
      ...(patch ? { body: JSON.stringify(patch) } : {}), redirect: "error", signal: AbortSignal.timeout(30_000),
    });
  } catch { fail("Cloud Run API request failed; token and response withheld."); }
  if (!response.ok) fail(`Cloud Run API rejected request (HTTP ${response.status}); response withheld.`);
  try {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 1_048_576) throw new Error();
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch { fail("Cloud Run response is invalid or too large; contents withheld."); }
}

async function smoke(fetchImpl) {
  for (const [path, status, location] of [["/login", 200, null], ["/records/new", 307, "/login"]]) {
    let response;
    try { response = await fetchImpl(`${PUBLIC_ORIGIN}${path}`, { redirect: "manual", signal: AbortSignal.timeout(30_000) }); }
    catch { fail("Anonymous public smoke request failed; details withheld."); }
    const received = response.headers.get("location");
    let valid = response.status === status && (location === null ? received === null : false);
    if (location && received) {
      try {
        const url = new URL(received, PUBLIC_ORIGIN);
        valid = response.status === status && url.origin === PUBLIC_ORIGIN && url.pathname === location && !url.hash;
      } catch { /* fail below */ }
    }
    await response.body?.cancel();
    if (!valid) fail("Anonymous public smoke failed; response body and headers withheld.");
  }
}

export async function deployExistingService({ env, pins, prepare, fetchImpl = fetch, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), log = console.log, maxPolls = 60 }) {
  requireContinuousContext(env);
  if (!env.GCP_ACCESS_TOKEN || /[\r\n]/.test(env.GCP_ACCESS_TOKEN)) fail("Short-lived WIF token is missing or invalid.");
  validateFixedVersions(JSON.stringify(pins), env);
  const get = () => api(fetchImpl, env.GCP_ACCESS_TOKEN);
  const initial = await get();
  validateService(initial);
  assertReady(initial);
  const oldRevision = shortRevision(initial.trafficStatuses?.[0]?.revision);
  if (!revisionName(oldRevision) || initial.latestCreatedRevision !== initial.latestReadyRevision ||
      !trafficIs(initial.traffic, oldRevision, shortRevision(initial.latestReadyRevision) === oldRevision) || !trafficIs(initial.trafficStatuses, oldRevision, true)) {
    fail("Deployment requires one healthy serving revision without split or tagged traffic.");
  }
  const serving = await api(fetchImpl, env.GCP_ACCESS_TOKEN, `${API}/revisions/${oldRevision}`);
  if (serving.name !== `${SERVICE_NAME}/revisions/${oldRevision}` || serving.serviceAccount !== RUNTIME || serving.reconciling === true ||
      !Array.isArray(serving.conditions) || !serving.conditions.some((condition) => condition.type === "Ready" && succeeded(condition)) ||
      serving.containers?.length !== 1 || !imageDigest(serving.containers[0].image)) {
    fail("The currently serving revision is not verified healthy; no update was attempted.");
  }
  const oldTraffic = [{ type: REVISION_TYPE, revision: oldRevision, percent: 100 }];
  // Enable only after publication. Never modify IAM / invoker settings to make this check pass.
  await smoke(fetchImpl);
  let manifest;
  await prepare((value) => { validateManifest(value, pins, env); manifest = value; });
  if (!manifest) fail("Candidate preparation did not produce a verified manifest.");
  const current = await get();
  validateService(current);
  assertReady(current);
  if (current.uid !== initial.uid || current.etag !== initial.etag) fail("Service changed while building; refusing concurrent deployment.");
  const revision = `${SERVICE}-${env.GITHUB_SHA.slice(0, 12)}-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
  if (!revisionName(revision)) fail("Generated revision name is invalid.");
  const runtimeEnv = [
    ...Object.entries(manifest.env).map(([name, value]) => ({ name, value })),
    ...Object.entries(manifest.secretVersions).map(([name, ref]) => {
      const parts = ref.split("/");
      return { name, valueSource: { secretKeyRef: { secret: parts[3], version: parts[5] } } };
    }),
  ];
  const patch = async (service, body, mask) => {
    const result = await api(fetchImpl, env.GCP_ACCESS_TOKEN, `${API}?updateMask=${encodeURIComponent(mask)}&allowMissing=false`, {
      name: SERVICE_NAME, etag: service.etag, ...body,
    });
    if (result.error) fail("Cloud Run update failed; operation details withheld.");
  };
  const poll = async (target, trafficRevision) => {
    for (let count = 0; count < maxPolls; count++) {
      const service = await get();
      validateService(service);
      if (service.uid !== initial.uid) fail("Service identity changed during deployment.");
      const created = shortRevision(service.latestCreatedRevision);
      if (created === target && service.reconciling !== true && service.terminalCondition?.state === "CONDITION_FAILED") {
        fail("Cloud Run revision failed readiness; details withheld.");
      }
      if (created === target && shortRevision(service.template.revision) === target && shortRevision(service.latestReadyRevision) === target && service.reconciling !== true &&
          succeeded(service.terminalCondition) && service.generation === service.observedGeneration &&
          trafficIs(service.traffic, trafficRevision) && trafficIs(service.trafficStatuses, trafficRevision)) return service;
      await wait(5_000);
    }
    fail("Cloud Run reconciliation timed out; inspect the service before retrying.");
  };
  log("Existing public service validated. Staging the fixed image while retaining the healthy revision's traffic.");
  await patch(current, { template: { revision, containers: [{ ...current.template.containers[0], image: manifest.image, env: runtimeEnv }] }, traffic: oldTraffic }, "template.revision,template.containers,traffic");
  const staged = await poll(revision, oldRevision);
  const actual = await api(fetchImpl, env.GCP_ACCESS_TOKEN, `${API}/revisions/${revision}`);
  if (actual.name !== `${SERVICE_NAME}/revisions/${revision}` || actual.serviceAccount !== RUNTIME || actual.reconciling === true ||
      !Array.isArray(actual.conditions) || !actual.conditions.some((condition) => condition.type === "Ready" && succeeded(condition)) ||
      actual.containers?.length !== 1 || actual.containers[0].image !== manifest.image || staged.template.containers[0].image !== manifest.image ||
      !runtimeEnvMatches(actual.containers[0].env, runtimeEnv) || !runtimeEnvMatches(staged.template.containers[0].env, runtimeEnv)) {
    fail("Staged revision identity, readiness, or image digest differs; healthy traffic remains unchanged.");
  }
  log("Staged revision is ready and its digest matches. Promoting the verified revision.");
  try {
    await patch(staged, { traffic: [{ type: REVISION_TYPE, revision, percent: 100 }] }, "traffic");
    await poll(revision, revision);
    await smoke(fetchImpl);
  } catch {
    try {
      const failed = await get();
      validateService(failed);
      if (failed.uid !== initial.uid || shortRevision(failed.template.revision) !== revision ||
          shortRevision(failed.latestCreatedRevision) !== revision || failed.template.containers[0].image !== manifest.image) throw new Error();
      if (!trafficIs(failed.traffic, oldRevision)) {
        if (!trafficIs(failed.traffic, revision)) throw new Error();
        await patch(failed, { traffic: oldTraffic }, "traffic");
      }
      await poll(revision, oldRevision);
    } catch { fail("Promotion failed and rollback could not be verified; inspect traffic manually. Details withheld."); }
    fail("Promotion or anonymous smoke failed; traffic was restored to the previous healthy revision.");
  }
  log("Cloud Run deployment succeeded: Ready revision, matching digest, login 200 and protected-page redirect verified.");
  return manifest;
}

async function main() {
  requireContinuousContext(process.env);
  let text;
  try { text = await readFile(new URL("./production-secret-versions.json", import.meta.url), "utf8"); }
  catch { fail("Committed secret reference file is unreadable; details withheld."); }
  const pins = validateFixedVersions(text, process.env);
  const env = { ...process.env, PRESEEDED_SECRET_VERSIONS: JSON.stringify(pins) };
  const manifest = await deployExistingService({ env, pins, prepare: (save) => prepareWithDocker(env, { mode: "production", save }) });
  if (env.CANDIDATE_PUBLIC_CONFIG) await writeFile(env.CANDIDATE_PUBLIC_CONFIG, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof DeploymentError ? error.message : "Continuous deployment failed; credentials, input and API details withheld.");
    process.exitCode = 1;
  });
}
