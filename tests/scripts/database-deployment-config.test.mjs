import test from "node:test";
import assert from "node:assert/strict";
import { databaseMode, databasePins, databasePublicEnv, databaseSourceConfig, DATABASE_VPC, isDatabaseVpc } from "../../scripts/gcp/database-deployment-config.mjs";
import { prepareCandidate } from "../../scripts/gcp/prepare-candidate.mjs";
import { validateFixedVersions, validateManifest, deployExistingService } from "../../scripts/gcp/deploy-existing-service.mjs";
import { PROJECT, PROJECT_NUMBER, SERVICE_NAME, PUBLIC_ORIGIN, IMAGE_BASE } from "../../scripts/gcp/production-config.mjs";
import { OPERATOR_IMAGE } from "../../scripts/gcp/deploy-database-job.mjs";
const env = { GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "push",
  GITHUB_WORKFLOW_REF: "godhuu0505/mfmf/.github/workflows/deploy-production.yml@refs/heads/main",
  GITHUB_SHA: "a".repeat(40), GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", GCP_DEPLOY_ENABLED: "true",
  GCP_AUTH_ENABLED: "true", GCP_PROJECT_ID: PROJECT, GCP_PROJECT_NUMBER: PROJECT_NUMBER, GCP_ACCESS_TOKEN: "PRIVATE_TOKEN" };
const pins = Object.fromEntries(Object.entries({ TOKEN_ENC_KEY: "mfmf-token-enc-key", GOOGLE_CLIENT_ID: "mfmf-google-client-id",
  GOOGLE_CLIENT_SECRET: "mfmf-google-client-secret", MFMF_DATABASE_PASSWORD: "mfmf-database-password", IDENTITY_PLATFORM_API_KEY: "mfmf-identity-platform-api-key" })
  .map(([key, name]) => [key, `projects/${PROJECT_NUMBER}/secrets/${name}/versions/1`]));
const publicEnv = databasePublicEnv({ SIGNUP_ENABLED: "false", SENTRY_ENVIRONMENT: "production", SENTRY_TRACES_SAMPLE_RATE: "0.1" });
const image = `${IMAGE_BASE}@sha256:${"b".repeat(64)}`;
const migrationImage = `${OPERATOR_IMAGE}@sha256:${"c".repeat(64)}`;
const manifest = () => ({ image, migrationImage, region: "asia-northeast1", service: "mfmf-candidate", env: publicEnv,
  features: { googleDriveConfigured: true, sentryConfigured: false }, secretVersions: { ...pins } });
test("mode and version pins reject ambiguous or floating configuration", () => {
  assert.equal(databaseMode({}), false); assert.equal(databaseMode(env), true);
  for (const value of ["TRUE", "1", "", " true"]) assert.throws(() => databaseMode({ GCP_AUTH_ENABLED: value }));
  assert.throws(() => databaseMode({ ...env, NEXT_PUBLIC_GCP_AUTH_ENABLED: "false" }));
  assert.deepEqual(validateFixedVersions(JSON.stringify(pins), env), pins);
  assert.throws(() => validateFixedVersions(JSON.stringify(pins), { ...env, GCP_AUTH_ENABLED: "false" }));
  const refs = { MFMF_DATABASE_PASSWORD: pins.MFMF_DATABASE_PASSWORD, IDENTITY_PLATFORM_API_KEY: pins.IDENTITY_PLATFORM_API_KEY };
  assert.deepEqual(databasePins(JSON.stringify(refs)), refs);
  assert.throws(() => databasePins(JSON.stringify({ ...refs, IDENTITY_PLATFORM_API_KEY: refs.IDENTITY_PLATFORM_API_KEY.replace("/1", "/latest") })));
  assert.ok(isDatabaseVpc(DATABASE_VPC)); assert.equal(isDatabaseVpc({ ...DATABASE_VPC, connector: "anything" }), false);
});
test("an explicitly pinned Sentry version is introduced only into the new GCP revision", () => {
  const ref = `projects/${PROJECT_NUMBER}/secrets/mfmf-sentry-dsn/versions/1`;
  const withSentry = { ...pins, SENTRY_DSN: ref };
  assert.deepEqual(validateFixedVersions(JSON.stringify(withSentry), env), withSentry);
  const service = { name: SERVICE_NAME, uri: PUBLIC_ORIGIN, template: { containers: [{ env: Object.entries(publicEnv).map(([name, value]) => ({ name, value })) }] } };
  const selected = databaseSourceConfig(service, withSentry);
  assert.equal(selected.features.sentryConfigured, true);
  assert.equal(selected.secretVersions.SENTRY_DSN, ref);
  const configured = { ...manifest(), features: { googleDriveConfigured: true, sentryConfigured: true }, secretVersions: withSentry };
  validateManifest(configured, withSentry, env);
  assert.throws(() => validateManifest({ ...configured, secretVersions: { ...withSentry, SENTRY_DSN: ref.replace('/1', '/2') } }, withSentry, env));
  assert.throws(() => validateFixedVersions(JSON.stringify({ ...pins, SENTRY_DSN: ref.replace('/1', '/latest') }), env));
  assert.throws(() => databaseSourceConfig({ ...service, template: { containers: [{ env: [{ name: 'SENTRY_DSN', valueSource: { secretKeyRef: { secret: 'mfmf-sentry-dsn', version: '2' } } }] }] } }, withSentry));
});
test("true manifest requires matching flags, fixed placeholders, both secret references and operator digest", () => {
  validateManifest(manifest(), pins, env);
  for (const change of [{ migrationImage: image }, { env: { ...publicEnv, NEXT_PUBLIC_GCP_AUTH_ENABLED: "false" } },
    { env: { ...publicEnv, NEXT_PUBLIC_SUPABASE_URL: "https://real.supabase.co" } },
    { secretVersions: { ...pins, MFMF_DATABASE_PASSWORD: pins.MFMF_DATABASE_PASSWORD.replace("/1", "/2") } }]) {
    assert.throws(() => validateManifest({ ...manifest(), ...change }, pins, env));
  }
});
test("true preparation reads no Vercel/server secret values, writes no secret version and builds both images", async () => {
  const requests = []; const builds = []; let saved;
  const fetchImpl = async (url, init) => {
    requests.push({ url, init }); assert.equal(init.method, "GET");
    if (url === `https://run.googleapis.com/v2/${SERVICE_NAME}`) return Response.json({ name: SERVICE_NAME, uri: PUBLIC_ORIGIN,
      template: { containers: [{ env: Object.entries(publicEnv).map(([name, value]) => ({ name, value })) }] } });
    if (url === `https://secretmanager.googleapis.com/v1/projects/${PROJECT_NUMBER}/secrets/mfmf-next-server-actions-key/versions/1:access`) {
      const key = Buffer.alloc(32, 6).toString("base64");
      return Response.json({ name: `projects/${PROJECT_NUMBER}/secrets/mfmf-next-server-actions-key/versions/1`, payload: { data: Buffer.from(key).toString("base64") } });
    }
    throw new Error("Unexpected secret or external read");
  };
  await prepareCandidate({ env: { ...env, PRESEEDED_SECRET_VERSIONS: JSON.stringify(pins) }, mode: "production", fetchImpl,
    docker: async (args, authenticated, secrets) => { builds.push({ args, authenticated, secrets });
      return args[0] === "image" ? JSON.stringify([args[2].includes("db-operator") ? migrationImage : image]) : ""; },
    save: async (value) => { saved = value; }, log: () => {} });
  assert.equal(requests.length, 2); assert.equal(builds.length, 6); assert.deepEqual(saved, manifest());
  assert.ok(builds[0].args.includes("NEXT_PUBLIC_GCP_AUTH_ENABLED=true"));
  assert.equal(builds[3].args[4], "Dockerfile.gcp-operator"); assert.equal(builds[3].secrets, undefined);
});
test("a legacy running service cannot implicitly become GCP mode", async () => {
  let calls = 0; let prepared = false; let upgraded = false;
  await assert.rejects(deployExistingService({ env, pins, prepare: async () => { prepared = true; }, upgrade: async () => { upgraded = true; },
    fetchImpl: async () => { calls++; return Response.json({ name: SERVICE_NAME, uri: PUBLIC_ORIGIN, template: {} }); } }));
  assert.equal(calls, 1); assert.equal(prepared, false); assert.equal(upgraded, false);
});

function deploymentFixture({ upgradeFailure = false, backupFailure = false, servingLegacy = false, smokeFailure } = {}) {
  const API = `https://run.googleapis.com/v2/${SERVICE_NAME}`;
  const old = "mfmf-candidate-old";
  const next = `mfmf-candidate-${env.GITHUB_SHA.slice(0, 12)}-123-1`;
  const revision = "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION";
  const tag = "verify-123-1";
  const tagged = `https://${tag}---${new URL(PUBLIC_ORIGIN).hostname}`;
  const runtimeEnv = [...Object.entries(publicEnv).map(([name, value]) => ({ name, value })),
    ...Object.entries(pins).map(([name, ref]) => ({ name, valueSource: { secretKeyRef: { secret: ref.split("/")[3], version: "1" } } }))];
  const initialContainer = { image, env: runtimeEnv, resources: { limits: { cpu: "1", memory: "1Gi" }, cpuIdle: true },
    ports: [{ name: "http1", containerPort: 8080 }] };
  const state = { name: SERVICE_NAME, uri: PUBLIC_ORIGIN, uid: "fixed-service", etag: "etag0", generation: "1", observedGeneration: "1",
    terminalCondition: { state: "CONDITION_SUCCEEDED" }, latestCreatedRevision: `${SERVICE_NAME}/revisions/${old}`,
    latestReadyRevision: `${SERVICE_NAME}/revisions/${old}`, scaling: { maxInstanceCount: 1 },
    traffic: [{ type: revision, revision: old, percent: 100 }], trafficStatuses: [{ type: revision, revision: old, percent: 100 }],
    template: { serviceAccount: "mfmf-runtime@mfmf-499612.iam.gserviceaccount.com", executionEnvironment: "EXECUTION_ENVIRONMENT_GEN2",
      scaling: { maxInstanceCount: 1 }, maxInstanceRequestConcurrency: 2, timeout: "60s", vpcAccess: structuredClone(DATABASE_VPC),
      containers: [structuredClone(initialContainer)] } };
  const events = [];
  const fetchImpl = async (url, options = {}) => {
    if ([PUBLIC_ORIGIN, tagged].includes(new URL(url).origin)) {
      const promoted = state.traffic.length === 1 && state.traffic[0].revision === next;
      if (url.endsWith("/login") && ((smokeFailure === "staged" && new URL(url).origin === tagged)
        || (smokeFailure === "promoted" && new URL(url).origin === PUBLIC_ORIGIN && promoted))) {
        return new Response("fixture failure", { status: 503 });
      }
      return url.endsWith("/login") ? new Response("fixture", { status: 200 }) : new Response(null, { status: 307, headers: { location: "/login" } });
    }
    if (options.method === "PATCH") {
      events.push("patch"); const patch = JSON.parse(options.body); assert.equal(patch.etag, state.etag);
      if (patch.template) { Object.assign(state.template, patch.template); state.latestCreatedRevision = `${SERVICE_NAME}/revisions/${next}`; }
      else state.latestReadyRevision = `${SERVICE_NAME}/revisions/${patch.traffic.find(item => item.percent === 100).revision}`;
      state.traffic = patch.traffic; state.trafficStatuses = patch.traffic.map((item) => item.tag ? { ...item, uri: tagged } : item);
      state.etag = `etag${events.length}`; return Response.json({ name: "accepted" });
    }
    if (url.includes("/revisions/")) {
      const isOld = url.endsWith(`/${old}`);
      return Response.json({ name: `${SERVICE_NAME}/revisions/${isOld ? old : next}`,
        serviceAccount: state.template.serviceAccount, conditions: [{ type: "Ready", state: "CONDITION_SUCCEEDED" }],
        containers: [isOld ? { ...initialContainer, env: servingLegacy ? [] : runtimeEnv } : state.template.containers[0]] });
    }
    assert.equal(url, API); return Response.json(state);
  };
  return { events, state, run: () => deployExistingService({ env, pins, fetchImpl, log: () => {}, wait: async () => {}, maxPolls: 2,
    prepare: async (save) => { events.push("prepare"); save(manifest()); },
    backups: async (options) => { events.push("backups"); assert.equal(options.image, migrationImage);
      if (backupFailure) throw new Error("Fixed backup failure"); return { backupsVerified: true }; },
    upgrade: async (options) => { events.push("upgrade"); assert.equal(options.image, migrationImage);
      if (upgradeFailure) throw new Error("Fixed upgrade failure"); return { upgradeVerified: true }; } }) };
}
test("GCP deployment waits for exact-image database upgrade before staging or promotion", async () => {
  const f = deploymentFixture(); assert.deepEqual(await f.run(), manifest());
  assert.deepEqual(f.events, ["prepare", "backups", "upgrade", "patch", "patch"]);
  assert.equal(f.state.template.maxInstanceRequestConcurrency, 2);
  assert.deepEqual(f.state.template.vpcAccess, DATABASE_VPC);
});
test("failed upgrade prevents all service writes", async () => {
  const f = deploymentFixture({ upgradeFailure: true }); await assert.rejects(f.run(), /Fixed upgrade failure/);
  assert.deepEqual(f.events, ["prepare", "backups", "upgrade"]);
});
test("failed backup maintenance prevents SQL upgrade and all service writes", async () => {
  const f = deploymentFixture({ backupFailure: true }); await assert.rejects(f.run(), /Fixed backup failure/);
  assert.deepEqual(f.events, ["prepare", "backups"]);
});
test("a GCP template with a legacy serving revision cannot trigger migration", async () => {
  const f = deploymentFixture({ servingLegacy: true }); await assert.rejects(f.run(), /cannot change authentication mode/);
  assert.deepEqual(f.events, []);
});
for (const smokeFailure of ["staged", "promoted"]) test(`GCP ${smokeFailure} smoke failure restores old traffic and removes the tag`, async () => {
  const f = deploymentFixture({ smokeFailure });
  await assert.rejects(f.run(), smokeFailure === "staged" ? /Staging failed; the previous healthy revision/ : /traffic was restored to the previous healthy revision/);
  assert.deepEqual(f.state.traffic, [{ type: "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION", revision: "mfmf-candidate-old", percent: 100 }]);
  assert.deepEqual(f.state.trafficStatuses, f.state.traffic);
  assert.deepEqual(f.events, smokeFailure === "staged" ? ["prepare", "backups", "upgrade", "patch", "patch"] : ["prepare", "backups", "upgrade", "patch", "patch", "patch"]);
  assert.deepEqual(f.state.template.vpcAccess, DATABASE_VPC);
  assert.equal(f.state.template.containers[0].resources.limits.memory, "1Gi");
});

test("continuous deployment preserves only the exact additional browser origin", async () => {
  const { preserveWebOriginEnv } = await import("../../scripts/gcp/deploy-existing-service.mjs");
  const item = { name: "GCP_AUTH_WEB_ORIGIN", value: "https://mfmf.sanba.net" };
  assert.deepEqual(preserveWebOriginEnv([item]), [item]);
  assert.deepEqual(preserveWebOriginEnv([]), []);
  assert.throws(() => preserveWebOriginEnv([item, item]));
  assert.throws(() => preserveWebOriginEnv([{ ...item, value: "https://evil.test" }]));
});
