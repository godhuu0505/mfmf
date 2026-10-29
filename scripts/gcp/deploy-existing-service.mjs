import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parsePreseededSecretVersions, prepareWithDocker, selectProductionConfig, SECRET_NAMES } from "./prepare-candidate.mjs";
import { DATABASE_ENV_KEYS, DATABASE_SECRETS, databaseMode, databasePins, databaseSourceConfig, isDatabaseVpc } from "./database-deployment-config.mjs";
import { deployDatabaseJob, operatorDigest, databaseJobDiagnostic } from "./deploy-database-job.mjs";
import { deployBackupJobs } from "./deploy-backup-jobs.mjs";
import { backupJobDiagnostic } from "./backup-job-config.mjs";
import { PROJECT, PROJECT_NUMBER, REGION, SERVICE, RUNTIME, SERVICE_NAME, PUBLIC_ORIGIN, IMAGE_BASE, requireContinuousContext } from "./production-config.mjs";

const API = `https://run.googleapis.com/v2/${SERVICE_NAME}`;
const REVISION_TYPE = "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION";
const LATEST_TYPE = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST";
const PIN_KEYS = ["TOKEN_ENC_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"];
const PUBLIC_KEYS = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SIGNUP_ENABLED", "SENTRY_ENVIRONMENT", "SENTRY_TRACES_SAMPLE_RATE"];
const RANKING_KEYS = ["MFMF_RANKING_ENABLED", "MFMF_RANKING_EXPIRES_AT"];
const RANKING_HARD_STOP = Date.parse("2027-06-24T00:00:00+09:00");
class DeploymentError extends Error {}
const fail = (message) => { throw new DeploymentError(message); };
const exactKeys = (object, keys) => object && typeof object === "object" && !Array.isArray(object) &&
  Object.keys(object).length === keys.length && keys.every((key) => Object.hasOwn(object, key));
const revisionName = (name) => typeof name === "string" && /^mfmf-candidate-[a-z0-9-]{1,48}$/.test(name);
const shortRevision = (value) => typeof value === "string" && value.startsWith(`${SERVICE_NAME}/revisions/`) ? value.slice(`${SERVICE_NAME}/revisions/`.length) : value;
const succeeded = (condition) => condition?.state === "CONDITION_SUCCEEDED";
const imageDigest = (value) => typeof value === "string" && value.startsWith(`${IMAGE_BASE}@sha256:`) && /^[a-f0-9]{64}$/.test(value.slice(`${IMAGE_BASE}@sha256:`.length));

// Server-only settings are read from the verified existing service, never from a
// public/build manifest or untrusted workflow input. Missing settings stay missing.
export function preserveRankingEnv(items = []) {
  const selected = items.filter((item) => RANKING_KEYS.includes(item?.name));
  if (new Set(selected.map((item) => item.name)).size !== selected.length || selected.some((item) =>
    !exactKeys(item, ["name", "value"]) || typeof item.value !== "string")) fail("Existing ranking settings are invalid.");
  const values = Object.fromEntries(selected.map((item) => [item.name, item.value]));
  if (values.MFMF_RANKING_ENABLED !== undefined && !["true", "false"].includes(values.MFMF_RANKING_ENABLED)) fail("Existing ranking flag is invalid.");
  const expiry = values.MFMF_RANKING_EXPIRES_AT;
  if ((values.MFMF_RANKING_ENABLED === "true" && !expiry) || (expiry !== undefined &&
      (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:Z|[+-]\d{2}:\d{2})$/.test(expiry) ||
       !Number.isFinite(Date.parse(expiry)) || Date.parse(expiry) > RANKING_HARD_STOP))) fail("Existing ranking expiry is invalid.");
  if (expiry !== undefined) {
    const calendarDay = new Date(`${expiry.slice(0, 10)}T00:00:00Z`);
    if (!Number.isFinite(calendarDay.getTime()) || calendarDay.toISOString().slice(0, 10) !== expiry.slice(0, 10)) fail("Existing ranking expiry is invalid.");
  }
  return selected.map(({ name, value }) => ({ name, value }));
}

export function validateFixedVersions(text, env) {
  const refs = parsePreseededSecretVersions({ ...env, PRESEEDED_SECRET_VERSIONS: text });
  const required = [...PIN_KEYS, ...(databaseMode(env) ? Object.keys(DATABASE_SECRETS) : [])];
  const expected = [...required, ...(databaseMode(env) && Object.hasOwn(refs, "SENTRY_DSN") ? ["SENTRY_DSN"] : [])];
  if (!exactKeys(refs, expected) || Object.values(refs).some((ref) => !ref.startsWith(`projects/${PROJECT_NUMBER}/`))) {
    fail("Committed secret references must match the authentication mode and fixed project-number references.");
  }
  return refs;
}

export function validateManifest(manifest, pins, env) {
  const database = databaseMode(env);
  const publicKeys = [...PUBLIC_KEYS, ...(database ? DATABASE_ENV_KEYS : [])];
  if (!exactKeys(manifest, ["image", "region", "service", "env", "features", "secretVersions", ...(database ? ["migrationImage"] : [])]) ||
      !imageDigest(manifest.image) || manifest.region !== REGION || manifest.service !== SERVICE ||
      (database && !operatorDigest(manifest.migrationImage)) || !exactKeys(manifest.env, publicKeys) || !exactKeys(manifest.features, ["googleDriveConfigured", "sentryConfigured"]) ||
      !manifest.secretVersions || typeof manifest.secretVersions !== "object" || Array.isArray(manifest.secretVersions)) {
    fail("Candidate public manifest is invalid; contents withheld.");
  }
  for (const key of Object.keys(pins)) if (manifest.secretVersions[key] !== pins[key]) fail("Candidate changed a committed secret reference.");
  for (const [key, ref] of Object.entries(manifest.secretVersions)) {
    if (!Object.hasOwn(SECRET_NAMES, key) || (!database && Object.hasOwn(DATABASE_SECRETS, key)) || typeof ref !== "string" ||
        !new RegExp(`^projects/(${PROJECT}|${PROJECT_NUMBER})/secrets/${SECRET_NAMES[key]}/versions/[1-9][0-9]*$`).test(ref)) {
      fail("Candidate secret reference is invalid.");
    }
  }
  // Reuse the source setting validation without manufacturing or reading server secret values.
  const entries = Object.entries(manifest.env).map(([key, value]) => ({ key, value, target: ["production"], type: "plain" }));
  entries.push(...PIN_KEYS.map((key) => ({ key, target: ["production"], type: "sensitive" })));
  const checked = database ? databaseSourceConfig({ name: SERVICE_NAME, uri: PUBLIC_ORIGIN,
    template: { containers: [{ env: Object.entries(manifest.env).map(([name, value]) => ({ name, value })) }] } }, pins)
    : selectProductionConfig({ envs: entries }, pins);
  if (publicKeys.some((key) => checked.publicEnv[key] !== manifest.env[key]) ||
      manifest.features.googleDriveConfigured !== true ||
      manifest.features.sentryConfigured !== Object.hasOwn(manifest.secretVersions, "SENTRY_DSN") ||
      env.GCP_PROJECT_ID !== PROJECT) fail("Candidate configuration does not match the validated source.");
}

function assertRuntimeMode(container, database) {
  const entries = (container.env ?? []).filter((item) => DATABASE_ENV_KEYS.includes(item?.name));
  if (new Set(entries.map((item) => item.name)).size !== entries.length || entries.some((item) => !exactKeys(item, ["name", "value"]))) fail("Runtime authentication settings are invalid.");
  const values = Object.fromEntries(entries.map((item) => [item.name, item.value]));
  if (database) {
    if (!exactKeys(values, DATABASE_ENV_KEYS) || values.GCP_AUTH_ENABLED !== "true" || values.NEXT_PUBLIC_GCP_AUTH_ENABLED !== "true"
      || values.GCP_PROJECT_ID !== PROJECT || values.GCP_AUTH_ORIGIN !== PUBLIC_ORIGIN) fail("Automatic deployment cannot change authentication mode.");
  } else if (entries.some((item) => !["GCP_AUTH_ENABLED", "NEXT_PUBLIC_GCP_AUTH_ENABLED"].includes(item.name) || item.value !== "false")) fail("Automatic deployment cannot change authentication mode.");
}

function validateService(service, database = false) {
  const template = service?.template;
  const container = template?.containers?.[0];
  if (service?.name !== SERVICE_NAME || service.uri !== PUBLIC_ORIGIN ||
      typeof service.uid !== "string" || !service.uid || typeof service.etag !== "string" || !service.etag ||
      service.deleteTime || service.defaultUriDisabled === true || service.iapEnabled === true || service.buildConfig ||
      (service.scaling?.minInstanceCount ?? 0) !== 0 || service.scaling?.maxInstanceCount !== 1 ||
      ![undefined, "AUTOMATIC"].includes(service.scaling?.scalingMode) ||
      (template?.scaling?.minInstanceCount ?? 0) !== 0 || template?.scaling?.maxInstanceCount !== 1 ||
      template?.serviceAccount !== RUNTIME || template.executionEnvironment !== "EXECUTION_ENVIRONMENT_GEN2" ||
      template.maxInstanceRequestConcurrency !== (database ? 2 : 10) || template.timeout !== "60s" ||
      (database ? !isDatabaseVpc(template.vpcAccess) : Boolean(template.vpcAccess)) || template.volumes?.length || template.healthCheckDisabled === true ||
      !Array.isArray(template.containers) || template.containers.length !== 1 || !imageDigest(container?.image) ||
      container.resources?.limits?.cpu !== "1" || container.resources?.limits?.memory !== (database ? "1Gi" : "512Mi") ||
      Object.keys(container.resources?.limits ?? {}).length !== 2 || container.resources?.cpuIdle !== true ||
      !Array.isArray(container.ports) || container.ports.length !== 1 || container.ports[0].containerPort !== 8080 ||
      container.ports[0].name !== "http1" || container.command?.length || container.args?.length ||
      container.volumeMounts?.length || container.sourceCode || container.baseImageUri) {
    fail("Existing service identity or runtime constraints differ; no service was created or reconfigured.");
  }
  const seen = new Set();
  for (const item of container.env ?? []) {
    if (!item || seen.has(item.name) || ![...PUBLIC_KEYS, ...DATABASE_ENV_KEYS, ...RANKING_KEYS, ...Object.keys(SECRET_NAMES).filter((key) => database || !Object.hasOwn(DATABASE_SECRETS, key))].includes(item.name)) {
      fail("Existing runtime has duplicate or unmanaged environment settings.");
    }
    seen.add(item.name);
    if (Object.hasOwn(SECRET_NAMES, item.name) && (Object.hasOwn(item, "value") || !item.valueSource?.secretKeyRef)) {
      fail("Existing server settings must use secret references.");
    }
  }
  preserveRankingEnv(container.env);
  assertRuntimeMode(container, database);
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

async function smoke(fetchImpl, origin = PUBLIC_ORIGIN) {
  for (const [path, status, location] of [["/login", 200, null], ["/records/new", 307, "/login"]]) {
    let response;
    try { response = await fetchImpl(`${origin}${path}`, { redirect: "manual", signal: AbortSignal.timeout(30_000) }); }
    catch { fail("Anonymous public smoke request failed; details withheld."); }
    const received = response.headers.get("location");
    let valid = response.status === status && (location === null ? received === null : false);
    if (location && received) {
      try {
        const url = new URL(received, origin);
        valid = response.status === status && url.origin === origin && url.pathname === location && !url.hash;
      } catch { /* fail below */ }
    }
    await response.body?.cancel();
    if (!valid) fail("Anonymous public smoke failed; response body and headers withheld.");
  }
}

export async function deployExistingService({ env, pins, prepare, fetchImpl = fetch, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), log = console.log, maxPolls = 60, upgrade = deployDatabaseJob, backups = deployBackupJobs }) {
  requireContinuousContext(env);
  const database = databaseMode(env);
  if (!env.GCP_ACCESS_TOKEN || /[\r\n]/.test(env.GCP_ACCESS_TOKEN)) fail("Short-lived WIF token is missing or invalid.");
  validateFixedVersions(JSON.stringify(pins), env);
  const get = () => api(fetchImpl, env.GCP_ACCESS_TOKEN);
  const initial = await get();
  validateService(initial, database);
  assertReady(initial);
  const oldRevision = shortRevision(initial.trafficStatuses?.[0]?.revision);
  if (!revisionName(oldRevision) ||
      !trafficIs(initial.traffic, oldRevision, shortRevision(initial.latestReadyRevision) === oldRevision) || !trafficIs(initial.trafficStatuses, oldRevision, true)) {
    fail("Deployment requires one healthy serving revision without split or tagged traffic.");
  }
  const verifyServing = async () => {
    const serving = await api(fetchImpl, env.GCP_ACCESS_TOKEN, `${API}/revisions/${oldRevision}`);
    if (serving.name !== `${SERVICE_NAME}/revisions/${oldRevision}` || serving.serviceAccount !== RUNTIME || serving.reconciling === true ||
        !Array.isArray(serving.conditions) || !serving.conditions.some((condition) => condition.type === "Ready" && succeeded(condition)) ||
        serving.containers?.length !== 1 || !imageDigest(serving.containers[0].image)) {
      fail("The currently serving revision is not verified healthy; no update was attempted.");
    }
    assertRuntimeMode(serving.containers[0], database);
  };
  await verifyServing();
  const oldTraffic = [{ type: REVISION_TYPE, revision: oldRevision, percent: 100 }];
  // Enable only after publication. Never modify IAM / invoker settings to make this check pass.
  await smoke(fetchImpl);
  let manifest;
  await prepare((value) => { validateManifest(value, pins, env); manifest = value; });
  if (!manifest) fail("Candidate preparation did not produce a verified manifest.");
  let current = await get();
  validateService(current, database);
  assertReady(current);
  if (current.uid !== initial.uid || current.etag !== initial.etag) fail("Service changed while building; refusing concurrent deployment.");
  if (database) {
    await verifyServing();
    await backups({ env, image: manifest.migrationImage, fetchImpl, wait });
    await upgrade({ env, image: manifest.migrationImage, fetchImpl, wait });
    current = await get();
    validateService(current, database);
    assertReady(current);
    if (current.uid !== initial.uid || current.etag !== initial.etag) fail("Service changed during database upgrade; refusing concurrent deployment.");
  }
  const revision = `${SERVICE}-${env.GITHUB_SHA.slice(0, 12)}-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
  if (!revisionName(revision)) fail("Generated revision name is invalid.");
  const tag = `verify-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
  const taggedHost = `${tag}---${new URL(PUBLIC_ORIGIN).hostname}`;
  if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(tag) || taggedHost.split(".")[0].length > 63) fail("Generated staging tag is invalid.");
  const taggedOrigin = `https://${taggedHost}`;
  const stagedTraffic = [...oldTraffic, { type: REVISION_TYPE, revision, percent: 0, tag }];
  const stagedTrafficIs = (targets, resolved = false) => {
    if (!Array.isArray(targets) || targets.length !== 2) return false;
    const old = targets.filter((target) => !target.tag);
    const tagged = targets.filter((target) => target.tag === tag);
    if (!trafficIs(old, oldRevision) || tagged.length !== 1 || tagged[0].type !== REVISION_TYPE ||
        shortRevision(tagged[0].revision) !== revision || (tagged[0].percent === undefined ? 0 : tagged[0].percent) !== 0) return false;
    if (resolved && tagged[0].uri && ![taggedOrigin, `${taggedOrigin}/`].includes(tagged[0].uri)) {
      fail("Cloud Run returned an unexpected staging URL; no request was sent to it.");
    }
    return !resolved || [taggedOrigin, `${taggedOrigin}/`].includes(tagged[0].uri);
  };
  const runtimeEnv = [
    ...Object.entries(manifest.env).map(([name, value]) => ({ name, value })),
    ...preserveRankingEnv(current.template.containers[0].env),
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
  const ownsCandidate = (service) => service.uid === initial.uid && shortRevision(service.template.revision) === revision &&
    service.template.containers[0].image === manifest.image && runtimeEnvMatches(service.template.containers[0].env, runtimeEnv);
  const poll = async (phase) => {
    for (let count = 0; count < maxPolls; count++) {
      const service = await get();
      validateService(service, database);
      if (!ownsCandidate(service)) {
        // A just-accepted PATCH may not be visible yet. Only the unchanged pre-PATCH snapshot is tolerable.
        if (phase === "staged" && service.uid === initial.uid && service.etag === current.etag) { await wait(5_000); continue; }
        fail("Service changed during deployment; refusing another update.");
      }
      if (![initial.latestCreatedRevision, `${SERVICE_NAME}/revisions/${revision}`, revision].includes(service.latestCreatedRevision)) {
        fail("Another revision appeared during deployment; refusing another update.");
      }
      if (phase === "staged" && !stagedTrafficIs(service.traffic)) fail("Staging traffic was changed; refusing promotion.");
      const reconciled = service.reconciling !== true && typeof service.generation === "string" && service.generation === service.observedGeneration;
      const created = shortRevision(service.latestCreatedRevision);
      if (phase !== "restored" && created === revision && reconciled && service.terminalCondition?.state === "CONDITION_FAILED") {
        fail("Cloud Run revision failed readiness; details withheld.");
      }
      if (reconciled) {
        if (phase === "restored" && trafficIs(service.traffic, oldRevision) && trafficIs(service.trafficStatuses, oldRevision)) return service;
        if (created === revision && succeeded(service.terminalCondition)) {
          // 0% / min0 can leave latestReady pointing at the serving old revision. The tag URI is probed below.
          if (phase === "staged" && stagedTrafficIs(service.traffic) && stagedTrafficIs(service.trafficStatuses, true)) return service;
          if (phase === "promoted" && shortRevision(service.latestReadyRevision) === revision &&
              trafficIs(service.traffic, revision) && trafficIs(service.trafficStatuses, revision)) return service;
        }
      }
      await wait(5_000);
    }
    fail("Cloud Run reconciliation timed out; inspect the service before retrying.");
  };
  log("Existing public service validated. Staging a tagged revision while retaining the healthy revision's traffic.");
  let promotionAttempted = false;
  try {
    await patch(current, { template: { revision, containers: [{ ...current.template.containers[0], image: manifest.image, env: runtimeEnv }] }, traffic: stagedTraffic }, "template.revision,template.containers,traffic");
    await poll("staged");
    // The API's URI must match the fixed service-derived URI, but fetch always uses our constructed constant.
    await smoke(fetchImpl, taggedOrigin);
    const actual = await api(fetchImpl, env.GCP_ACCESS_TOKEN, `${API}/revisions/${revision}`);
    if (actual.name !== `${SERVICE_NAME}/revisions/${revision}` || actual.serviceAccount !== RUNTIME || actual.reconciling === true ||
        !Array.isArray(actual.conditions) || !actual.conditions.some((condition) => condition.type === "Ready" && succeeded(condition)) ||
        actual.containers?.length !== 1 || actual.containers[0].image !== manifest.image || !runtimeEnvMatches(actual.containers[0].env, runtimeEnv)) {
      fail("Staged revision identity, readiness, image digest or environment differs.");
    }
    // Re-read after smoke/readiness checks; the ETag and exact owned traffic guard the promotion.
    const staged = await poll("staged");
    log("Tagged revision passed anonymous smoke, Ready, digest and environment checks. Promoting and removing the tag.");
    promotionAttempted = true;
    await patch(staged, { traffic: [{ type: REVISION_TYPE, revision, percent: 100 }] }, "traffic");
    await poll("promoted");
    await smoke(fetchImpl);
    await poll("promoted");
  } catch {
    try {
      const failed = await get();
      validateService(failed, database);
      const unchanged = failed.uid === initial.uid && failed.etag === current.etag &&
        trafficIs(failed.traffic, oldRevision, shortRevision(failed.latestReadyRevision) === oldRevision) &&
        trafficIs(failed.trafficStatuses, oldRevision, true);
      if (!unchanged) {
        if (!ownsCandidate(failed) || ![initial.latestCreatedRevision, `${SERVICE_NAME}/revisions/${revision}`, revision].includes(failed.latestCreatedRevision)) throw new Error();
        if (!trafficIs(failed.traffic, oldRevision)) {
          if (!stagedTrafficIs(failed.traffic) && !(promotionAttempted && trafficIs(failed.traffic, revision))) throw new Error();
          await patch(failed, { traffic: oldTraffic }, "traffic");
        }
        // Removing the tag can retire the new revision again. Only old traffic and its health matter here.
        await poll("restored");
      }
      await verifyServing();
      await smoke(fetchImpl);
      if (unchanged) {
        const finalState = await get();
        validateService(finalState, database);
        assertReady(finalState);
        if (finalState.uid !== initial.uid || finalState.etag !== current.etag ||
            !trafficIs(finalState.traffic, oldRevision, shortRevision(finalState.latestReadyRevision) === oldRevision) ||
            !trafficIs(finalState.trafficStatuses, oldRevision, true)) throw new Error();
      } else await poll("restored");
    } catch { fail("Deployment failed and traffic/tag cleanup could not be verified; inspect manually. Details withheld."); }
    fail(promotionAttempted ? "Promotion or anonymous smoke failed; traffic was restored to the previous healthy revision and the staging tag removed."
      : "Staging failed; the previous healthy revision retains all traffic and the staging tag is absent.");
  }
  log("Cloud Run deployment succeeded: Ready revision, matching digest, login 200 and protected-page redirect verified.");
  return manifest;
}

async function main() {
  requireContinuousContext(process.env);
  let text;
  try { text = await readFile(new URL("./production-secret-versions.json", import.meta.url), "utf8"); }
  catch { fail("Committed secret reference file is unreadable; details withheld."); }
  if (databaseMode(process.env)) {
    let refs;
    try { refs = databasePins(await readFile(new URL("./production-database-secret-versions.json", import.meta.url), "utf8")); }
    catch { fail("Committed database secret references are unreadable or invalid."); }
    let sentry;
    try { sentry = JSON.parse(await readFile(new URL("./production-sentry-secret-version.json", import.meta.url), "utf8")); }
    catch { fail("Committed Sentry secret reference is unreadable or invalid."); }
    if (sentry !== null && !exactKeys(sentry, ["SENTRY_DSN"])) fail("Committed Sentry secret reference is invalid.");
    text = JSON.stringify({ ...JSON.parse(text), ...refs, ...(sentry ?? {}) });
  }
  const pins = validateFixedVersions(text, process.env);
  const env = { ...process.env, PRESEEDED_SECRET_VERSIONS: JSON.stringify(pins) };
  const manifest = await deployExistingService({ env, pins, prepare: (save) => prepareWithDocker(env, { mode: "production", save }) });
  if (env.CANDIDATE_PUBLIC_CONFIG) await writeFile(env.CANDIDATE_PUBLIC_CONFIG, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

export function deploymentErrorMessage(error) {
  const database = databaseJobDiagnostic(error);
  if (database) return JSON.stringify(database);
  const backup = backupJobDiagnostic(error);
  if (backup) return JSON.stringify(backup);
  return error instanceof DeploymentError ? error.message : "Continuous deployment failed; credentials, input and API details withheld.";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(deploymentErrorMessage(error));
    process.exitCode = 1;
  });
}
