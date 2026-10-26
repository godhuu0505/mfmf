import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deployExistingService, validateFixedVersions, validateManifest } from "../../scripts/gcp/deploy-existing-service.mjs";
import { IMAGE_BASE, PROJECT, PROJECT_NUMBER, PUBLIC_ORIGIN, REGION, RUNTIME, SERVICE, SERVICE_NAME } from "../../scripts/gcp/production-config.mjs";

const env = {
  GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "push",
  GITHUB_WORKFLOW_REF: "godhuu0505/mfmf/.github/workflows/deploy-production.yml@refs/heads/main",
  GITHUB_SHA: "a".repeat(40), GITHUB_RUN_ID: "123456789", GITHUB_RUN_ATTEMPT: "1",
  GCP_DEPLOY_ENABLED: "true", GCP_PROJECT_ID: PROJECT, GCP_PROJECT_NUMBER: PROJECT_NUMBER,
  GCP_ACCESS_TOKEN: "private-wif-token-fixture",
};
const pins = {
  TOKEN_ENC_KEY: `projects/${PROJECT_NUMBER}/secrets/mfmf-token-enc-key/versions/1`,
  GOOGLE_CLIENT_ID: `projects/${PROJECT_NUMBER}/secrets/mfmf-google-client-id/versions/1`,
  GOOGLE_CLIENT_SECRET: `projects/${PROJECT_NUMBER}/secrets/mfmf-google-client-secret/versions/1`,
};
const manifest = () => ({
  image: `${IMAGE_BASE}@sha256:${"b".repeat(64)}`, region: REGION, service: SERVICE,
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_fixture",
    SIGNUP_ENABLED: "false", SENTRY_ENVIRONMENT: "cloud-run-candidate", SENTRY_TRACES_SAMPLE_RATE: "0.1",
  }, features: { googleDriveConfigured: true, sentryConfigured: false }, secretVersions: { ...pins },
});
const oldRevision = `${SERVICE}-00001-dsb`;
const revision = `${SERVICE}-${env.GITHUB_SHA.slice(0, 12)}-${env.GITHUB_RUN_ID}-1`;
const API = `https://run.googleapis.com/v2/${SERVICE_NAME}`;
const REVISION = "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION";
const LATEST = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST";
const initial = () => ({
  name: SERVICE_NAME, uid: "fixed-service-uid", uri: PUBLIC_ORIGIN, etag: '"initial-etag"',
  generation: "1", observedGeneration: "1", terminalCondition: { state: "CONDITION_SUCCEEDED" },
  latestCreatedRevision: `${SERVICE_NAME}/revisions/${oldRevision}`, latestReadyRevision: `${SERVICE_NAME}/revisions/${oldRevision}`,
  ingress: "INGRESS_TRAFFIC_ALL", scaling: { maxInstanceCount: 1 },
  traffic: [{ type: LATEST, percent: 100 }], trafficStatuses: [{ type: LATEST, revision: oldRevision, percent: 100 }],
  template: {
    serviceAccount: RUNTIME, scaling: { maxInstanceCount: 1 }, maxInstanceRequestConcurrency: 10,
    timeout: "60s", executionEnvironment: "EXECUTION_ENVIRONMENT_GEN2",
    containers: [{ image: `${IMAGE_BASE}@sha256:${"c".repeat(64)}`,
      resources: { limits: { cpu: "1", memory: "512Mi" }, cpuIdle: true, startupCpuBoost: true },
      ports: [{ name: "http1", containerPort: 8080 }],
      startupProbe: { timeoutSeconds: 240, periodSeconds: 240, failureThreshold: 1, tcpSocket: { port: 8080 } },
      env: Object.entries(manifest().env).map(([name, value]) => ({ name, value })),
    }],
  },
});

function harness({ service = initial(), failure = "", candidate = manifest() } = {}) {
  let state = structuredClone(service);
  let patches = 0;
  let smokeCount = 0;
  const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], options?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(PUBLIC_ORIGIN)) {
      smokeCount++;
      if (failure === "concurrent-promotion" && smokeCount === 3) {
        state.latestCreatedRevision = `${SERVICE_NAME}/revisions/${SERVICE}-operator-new`;
        return new Response("private-response-marker", { status: 403 });
      }
      if (failure === "concurrent-template" && smokeCount === 3) {
        Object.assign(state.template, { revision: `${SERVICE}-operator-new` });
        return new Response("private-response-marker", { status: 403 });
      }
      if ((failure === "baseline-private" && smokeCount === 1) || (failure === "smoke" && smokeCount === 3)) return new Response("private-response-marker", { status: 403 });
      return url.endsWith("/login") ? new Response("login", { status: 200 }) : new Response(null, { status: 307, headers: { location: "/login" } });
    }
    if (options?.method === "PATCH") {
      patches++;
      if (failure === "stage-denied" && patches === 1) return new Response("private-response-marker", { status: 403 });
      if (failure === "rollback-denied" && patches === 3) return new Response("private-response-marker", { status: 403 });
      if (failure === "rollback-conflict" && patches === 3) return new Response("private-response-marker", { status: 409 });
      const patch = JSON.parse(String(options.body));
      expect(patch.etag).toBe(state.etag);
      if (patch.template) {
        Object.assign(state.template, patch.template);
        state.latestCreatedRevision = `${SERVICE_NAME}/revisions/${revision}`;
        state.latestReadyRevision = state.latestCreatedRevision;
      }
      state.traffic = patch.traffic;
      state.trafficStatuses = patch.traffic;
      state.etag = `etag-${patches}`;
      state.generation = state.observedGeneration = String(patches + 1);
      if (failure === "stage-readiness" && patches === 1) state.terminalCondition.state = "CONDITION_FAILED";
      if (failure === "stage-pending" && patches === 1) state.terminalCondition.state = "CONDITION_PENDING";
      if (["promote-uncertain", "rollback-denied", "rollback-conflict"].includes(failure) && patches === 2) throw new Error("private-response-marker");
      return Response.json({ name: "operation-fixture" });
    }
    if (url === `${API}/revisions/${revision}`) return Response.json({
      name: `${SERVICE_NAME}/revisions/${revision}`, serviceAccount: RUNTIME,
      conditions: [{ type: "Ready", state: "CONDITION_SUCCEEDED" }],
      containers: [{ image: failure === "wrong-digest" ? `${IMAGE_BASE}@sha256:${"d".repeat(64)}` : candidate.image,
        env: failure === "wrong-env" ? [] : state.template.containers[0].env }],
    });
    if (url === `${API}/revisions/${oldRevision}`) return Response.json({
      name: `${SERVICE_NAME}/revisions/${oldRevision}`, serviceAccount: RUNTIME,
      conditions: [{ type: "Ready", state: failure === "old-unhealthy" ? "CONDITION_FAILED" : "CONDITION_SUCCEEDED" }],
      containers: [{ image: initial().template.containers[0].image }],
    });
    if (url !== API) throw new Error("unexpected endpoint");
    return Response.json(state);
  });
  const prepare = vi.fn(async (save: (value: ReturnType<typeof manifest>) => void) => {
    if (failure === "prepare") throw new Error("private-candidate-marker");
    if (failure === "race") state.etag = "operator-change";
    save(candidate);
  });
  const log = vi.fn();
  const run = (settings = env) => deployExistingService({ env: settings, pins, prepare, fetchImpl, wait: vi.fn(), log, maxPolls: 2 });
  return { run, fetchImpl, prepare, log, state: () => state, patches: () => patches };
}

describe("existing Cloud Run continuous deployment", () => {
  it("stages with old traffic, verifies readiness/digest, then promotes and anonymously smokes", async () => {
    const h = harness();
    expect(await h.run()).toEqual(manifest());
    const writes = h.fetchImpl.mock.calls.filter(([, options]) => options?.method === "PATCH");
    expect(writes).toHaveLength(2);
    const stage = JSON.parse(String(writes[0][1]?.body));
    expect(stage.traffic).toEqual([{ type: REVISION, revision: oldRevision, percent: 100 }]);
    expect(stage.template.revision).toBe(revision);
    expect(stage.template.containers[0].image).toBe(manifest().image);
    expect(stage.template.containers[0].env.filter((item: { valueSource?: object }) => item.valueSource)).toEqual([
      { name: "TOKEN_ENC_KEY", valueSource: { secretKeyRef: { secret: "mfmf-token-enc-key", version: "1" } } },
      { name: "GOOGLE_CLIENT_ID", valueSource: { secretKeyRef: { secret: "mfmf-google-client-id", version: "1" } } },
      { name: "GOOGLE_CLIENT_SECRET", valueSource: { secretKeyRef: { secret: "mfmf-google-client-secret", version: "1" } } },
    ]);
    expect(Object.keys(stage).sort()).toEqual(["etag", "name", "template", "traffic"]);
    expect(JSON.parse(String(writes[1][1]?.body))).toEqual({ name: SERVICE_NAME, etag: "etag-1", traffic: [{ type: REVISION, revision, percent: 100 }] });
    for (const [input, options] of h.fetchImpl.mock.calls) {
      const url = String(input);
      if (url.startsWith(PUBLIC_ORIGIN)) { expect(options?.headers).toBeUndefined(); expect(options?.redirect).toBe("manual"); }
      else { expect(options?.redirect).toBe("error"); expect(options?.headers).toHaveProperty("Authorization", `Bearer ${env.GCP_ACCESS_TOKEN}`); }
      if (options?.method === "PATCH") expect(new URL(url).searchParams.get("allowMissing")).toBe("false");
    }
    expect(JSON.stringify(h.log.mock.calls)).not.toContain(env.GCP_ACCESS_TOKEN);
  });

  it.each([
    { GCP_DEPLOY_ENABLED: "false" }, { GCP_DEPLOY_ENABLED: "" }, { GCP_DEPLOY_ENABLED: "TRUE" },
    { GITHUB_EVENT_NAME: "workflow_dispatch" }, { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_REF: "refs/pull/1/merge" }, { GITHUB_ACTIONS: "false" },
    { GITHUB_WORKFLOW_REF: "godhuu0505/mfmf/.github/workflows/deploy-cloud-run.yml@refs/heads/main" },
    { GCP_PROJECT_ID: "other-project" }, { GCP_PROJECT_NUMBER: "123456789" }, { GITHUB_SHA: "invalid" },
  ])("rejects the wrong execution boundary before any request: %j", async (change) => {
    const h = harness();
    await expect(h.run({ ...env, ...change })).rejects.toThrow("enabled production main push");
    expect(h.fetchImpl).not.toHaveBeenCalled(); expect(h.prepare).not.toHaveBeenCalled();
  });

  it.each(["identity", "runtime", "max", "min", "cpu", "memory", "container", "command", "env", "not-ready", "split", "tag", "wrong-url"])("rejects unsafe existing %s before building or mutation", async (change) => {
    const service = initial();
    if (change === "identity") service.name = SERVICE_NAME.replace(PROJECT, "other-project");
    if (change === "runtime") service.template.serviceAccount = "other@example.invalid";
    if (change === "max") service.scaling.maxInstanceCount = 2;
    if (change === "min") Object.assign(service.template.scaling, { minInstanceCount: 1 });
    if (change === "cpu") service.template.containers[0].resources.limits.cpu = "2";
    if (change === "memory") service.template.containers[0].resources.limits.memory = "1Gi";
    if (change === "container") service.template.containers.push(structuredClone(service.template.containers[0]));
    if (change === "command") Object.assign(service.template.containers[0], { command: ["unmanaged"] });
    if (change === "env") service.template.containers[0].env.push({ name: "UNMANAGED_SECRET", value: "private-marker" });
    if (change === "not-ready") service.terminalCondition.state = "CONDITION_PENDING";
    if (change === "split") service.traffic[0].percent = 50;
    if (change === "tag") Object.assign(service.traffic[0], { tag: "old-preview" });
    if (change === "wrong-url") service.uri = "https://attacker.invalid";
    const h = harness({ service }); await expect(h.run()).rejects.toThrow();
    expect(h.prepare).not.toHaveBeenCalled(); expect(h.patches()).toBe(0);
  });

  it.each(["baseline-private", "prepare", "race", "old-unhealthy"])("makes no Cloud Run mutation on %s", async (failure) => {
    const h = harness({ failure }); await expect(h.run()).rejects.toThrow(); expect(h.patches()).toBe(0);
  });
  it.each(["stage-denied", "stage-readiness", "stage-pending", "wrong-digest", "wrong-env"])("never promotes on %s", async (failure) => {
    const h = harness({ failure }); const error = await h.run().catch((value: Error) => value);
    expect(error).toBeInstanceOf(Error); expect(String(error)).not.toContain("private-response-marker"); expect(h.patches()).toBe(1);
    expect(h.state().traffic[0].percent).toBe(100);
    expect((h.state().traffic[0] as { revision?: string }).revision ?? oldRevision).toBe(oldRevision);
  });
  it.each(["smoke", "promote-uncertain"])("restores the old traffic after %s", async (failure) => {
    const h = harness({ failure }); await expect(h.run()).rejects.toThrow("restored"); expect(h.patches()).toBe(3);
    expect(h.state().traffic).toEqual([{ type: REVISION, revision: oldRevision, percent: 100 }]);
  });
  it("allows the next release after a smoke rollback while latestReady differs from serving traffic", async () => {
    const service = initial();
    service.latestCreatedRevision = service.latestReadyRevision = `${SERVICE_NAME}/revisions/${SERVICE}-previous-rolled-back`;
    service.traffic = [{ type: REVISION, percent: 100, ...{ revision: oldRevision } }];
    service.trafficStatuses = [{ type: REVISION, percent: 100, revision: oldRevision }];
    const h = harness({ service }); await expect(h.run()).resolves.toEqual(manifest()); expect(h.patches()).toBe(2);
  });
  it.each(["rollback-denied", "rollback-conflict"])("does not retry or falsely claim rollback on %s", async (failure) => {
    const h = harness({ failure }); await expect(h.run()).rejects.toThrow("rollback could not be verified"); expect(h.patches()).toBe(3);
  });
  it.each(["concurrent-promotion", "concurrent-template"])("does not overwrite %s during rollback", async (failure) => {
    const h = harness({ failure });
    await expect(h.run()).rejects.toThrow("rollback could not be verified"); expect(h.patches()).toBe(2);
  });
  it("rejects unreviewed secrets, mutable images and privileged public values before staging", async () => {
    for (const mutate of [
      (m: ReturnType<typeof manifest>) => { m.image = `${IMAGE_BASE}:latest`; },
      (m: ReturnType<typeof manifest>) => { m.secretVersions.TOKEN_ENC_KEY = pins.TOKEN_ENC_KEY.replace("/1", "/2"); },
      (m: ReturnType<typeof manifest>) => { m.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "sb_secret_private"; },
      (m: ReturnType<typeof manifest>) => { Object.assign(m.env, { GOOGLE_CLIENT_SECRET: "private-marker" }); },
    ]) {
      const candidate = manifest(); mutate(candidate); const h = harness({ candidate });
      await expect(h.run()).rejects.toThrow(); expect(h.patches()).toBe(0);
    }
  });
  it.each(["latest", "0", "01", "-1"])("rejects mutable or invalid committed version %s", (version) => {
    expect(() => validateFixedVersions(JSON.stringify({ ...pins, TOKEN_ENC_KEY: pins.TOKEN_ENC_KEY.replace(/1$/, version) }), env)).toThrow();
  });
  it("requires all three fixed metadata references and rejects extras", () => {
    for (const refs of [{}, { ...pins, OTHER: "private-marker" }, { ...pins, TOKEN_ENC_KEY: pins.TOKEN_ENC_KEY.replace(PROJECT_NUMBER, PROJECT) }]) {
      expect(() => validateFixedVersions(JSON.stringify(refs), env)).toThrow();
    }
    expect(() => validateManifest(manifest(), pins, env)).not.toThrow();
  });
  it("commits only fixed numeric refs and keeps job disabled unless explicitly enabled", async () => {
    const committed = await readFile(new URL("../../scripts/gcp/production-secret-versions.json", import.meta.url), "utf8");
    expect(validateFixedVersions(committed, env)).toEqual(pins);
    const workflow = await readFile(new URL("../../.github/workflows/deploy-production.yml", import.meta.url), "utf8");
    const job = workflow.slice(workflow.indexOf("  deploy-cloud-run:"));
    for (const gate of ["vars.GCP_DEPLOY_ENABLED == 'true'", "needs.verify.result == 'success'", "needs.migrate.result == 'success'", "github.event_name == 'push'", "github.ref == 'refs/heads/main'"]) expect(job).toContain(gate);
    expect(job).toContain("create_credentials_file: false"); expect(job).not.toContain("preseeded_secret_versions");
  });
  it.each(["network", "forbidden", "invalid-json", "oversize"])("CLI withholds token and %s API response before writes", async (failure) => {
    const scratch = await mkdtemp(join(tmpdir(), "mfmf-continuous-cli-test-"));
    try {
      const marker = "PRIVATE_API_RESPONSE_MUST_NOT_LEAK";
      const preload = join(scratch, "fake-network.mjs");
      const expression = failure === "network" ? `throw new Error(${JSON.stringify(marker)})`
        : `return new Response(${JSON.stringify(failure === "oversize" ? marker.repeat(40_000) : marker)}, {status:${failure === "forbidden" ? 403 : 200}})`;
      await writeFile(preload, `globalThis.fetch = async () => { ${expression}; };`);
      const manifestPath = join(scratch, "public.json");
      const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", preload, fileURLToPath(new URL("../../scripts/gcp/deploy-existing-service.mjs", import.meta.url))], {
          env: { ...env, NODE_ENV: "test", CANDIDATE_PUBLIC_CONFIG: manifestPath }, stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
        child.on("error", reject); child.on("close", (code) => resolve({ code, output }));
      });
      expect(result.code).toBe(1); expect(result.output).not.toContain(marker); expect(result.output).not.toContain(env.GCP_ACCESS_TOKEN);
      await expect(readFile(manifestPath)).rejects.toThrow();
    } finally { await rm(scratch, { recursive: true, force: true }); }
  });
});
