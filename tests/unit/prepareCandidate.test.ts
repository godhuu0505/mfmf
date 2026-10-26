import { describe, expect, it, vi } from "vitest";
import { parsePreseededSecretVersions, prepareCandidate, SECRET_NAMES, selectProductionConfig } from "../../scripts/gcp/prepare-candidate.mjs";
import { dockerCredential } from "../../scripts/gcp/docker-credential-mfmf-wif.mjs";

const secretValues = {
  TOKEN_ENC_KEY: " exact-existing-key-do-not-change ",
  GOOGLE_CLIENT_ID: "123-test.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "oauth-secret-fixture",
  SENTRY_DSN: "https://fixture@example.invalid/1",
};
const publicValues = {
  NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_fixture",
};
const env = {
  GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_SHA: "a".repeat(40), GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1",
  GCP_PROJECT_ID: "mfmf-project", GCP_PROJECT_NUMBER: "123456789", GCP_ACCESS_TOKEN: "wif-fixture",
  PRESEEDED_SECRET_VERSIONS: "",
  VERCEL_TOKEN: "vercel-fixture", VERCEL_ORG_ID: "team_fixture", VERCEL_PROJECT_ID: "prj_fixture",
};
const imageBase = "asia-northeast1-docker.pkg.dev/mfmf-project/mfmf/mfmf-candidate";
const digest = `${imageBase}@sha256:${"b".repeat(64)}`;
const entry = (key: string, value: string) => ({ id: `env_${key}`, key, value, target: ["production"], type: "encrypted", decrypted: true });
const response = () => ({ envs: Object.entries({ ...publicValues, ...secretValues }).map(([key, value]) => entry(key, value)) });
const pinned = {
  TOKEN_ENC_KEY: "projects/mfmf-project/secrets/mfmf-token-enc-key/versions/1",
  GOOGLE_CLIENT_ID: "projects/123456789/secrets/mfmf-google-client-id/versions/2",
  GOOGLE_CLIENT_SECRET: "projects/mfmf-project/secrets/mfmf-google-client-secret/versions/3",
};
const preseededEnv = { ...env, PRESEEDED_SECRET_VERSIONS: JSON.stringify(pinned) };
const sensitiveResponse = () => ({ envs: response().envs.filter((item) => item.key !== "SENTRY_DSN").map((item) =>
  item.key in pinned ? { ...item, type: "sensitive", decrypted: false } : item) });

function harness(data = response(), failureAt?: number, details = data) {
  let requestCount = 0;
  const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], options?: RequestInit) => {
    const url = String(input);
    requestCount++;
    if (requestCount === failureAt) return new Response("never-log-sensitive-api-body", { status: 403 });
    if (options?.method === "GET") {
      if (url.includes("/v10/")) return Response.json(data);
      const id = new URL(url).pathname.split("/").pop();
      return Response.json(details.envs[data.envs.findIndex((item) => item.id === id)] ?? {});
    }
    const secret = url.split("/secrets/")[1].split(":")[0];
    return Response.json({ name: `projects/123456789/secrets/${secret}/versions/4` });
  });
  const docker = vi.fn(async (args: string[]) => args[0] === "image" ? JSON.stringify([digest]) : "");
  const save = vi.fn(async () => {});
  const log = vi.fn();
  const run = (settings = env) => prepareCandidate({ env: settings, fetchImpl, docker, save, log });
  return { fetchImpl, docker, save, log, run };
}

describe("candidate preparation", () => {
  it("uses explicitly pinned versions without retrieving, uploading, or exposing their values", async () => {
    const data = sensitiveResponse();
    data.envs.push({ ...entry("TOKEN_ENC_KEY", "preview-key-must-not-be-used"), target: ["preview"] });
    const { run, fetchImpl, docker, save, log } = harness(data);
    await run(preseededEnv);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls.every(([url, options]) => options?.method === "GET" && String(url).startsWith("https://api.vercel.com/"))).toBe(true);
    expect(fetchImpl.mock.calls.slice(1).map(([url]) => String(url))).toEqual([
      "https://api.vercel.com/v1/projects/prj_fixture/env/env_NEXT_PUBLIC_SUPABASE_URL?teamId=team_fixture",
      "https://api.vercel.com/v1/projects/prj_fixture/env/env_NEXT_PUBLIC_SUPABASE_ANON_KEY?teamId=team_fixture",
    ]);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      secretVersions: pinned, features: { googleDriveConfigured: true, sentryConfigured: false },
      env: expect.objectContaining({ SIGNUP_ENABLED: "false" }),
    }));
    const output = JSON.stringify([fetchImpl.mock.calls, docker.mock.calls, save.mock.calls, log.mock.calls]);
    for (const value of [...Object.values(secretValues), "preview-key-must-not-be-used"]) expect(output).not.toContain(value);
  });

  it("only skips explicit pins while transferring other readable production secrets", async () => {
    const data = response();
    data.envs[2].type = "sensitive";
    const { run, fetchImpl, save } = harness(data);
    await run({ ...env, PRESEEDED_SECRET_VERSIONS: JSON.stringify({ TOKEN_ENC_KEY: pinned.TOKEN_ENC_KEY }) });
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes("env_TOKEN_ENC_KEY"))).toBe(false);
    const writes = fetchImpl.mock.calls.filter(([, options]) => options?.method === "POST");
    expect(writes).toHaveLength(3);
    expect(writes.some(([url]) => String(url).includes("mfmf-token-enc-key"))).toBe(false);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ secretVersions: expect.objectContaining({ TOKEN_ENC_KEY: pinned.TOKEN_ENC_KEY }) }));
  });

  it.each([
    "projects/other-project/secrets/mfmf-token-enc-key/versions/1",
    "projects/987654321/secrets/mfmf-token-enc-key/versions/1",
    "projects/mfmf-project/secrets/another-secret/versions/1",
    "projects/mfmf-project/secrets/mfmf-token-enc-key/versions/latest",
    "projects/mfmf-project/secrets/mfmf-token-enc-key/versions/0",
    "projects/mfmf-project/secrets/mfmf-token-enc-key/versions/-1",
    "projects/mfmf-project/secrets/mfmf-token-enc-key/versions/01",
    "projects/mfmf-project/secrets/mfmf-token-enc-key/versions/1?alt=json",
  ])("rejects an invalid pin before any API request: %s", async (reference) => {
    const { run, fetchImpl, docker } = harness(sensitiveResponse());
    await expect(run({ ...env, PRESEEDED_SECRET_VERSIONS: JSON.stringify({ TOKEN_ENC_KEY: reference }) })).rejects.toThrow("fixed names");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(docker).not.toHaveBeenCalled();
  });

  it.each(["null", "[]", "invalid-secret-fixture", '{"UNRELATED_SECRET":"private-fixture"}', '{"SENTRY_DSN":"private-fixture"}', '{"TOKEN_ENC_KEY":12}'])("rejects invalid pin JSON without exposing it", async (input) => {
    const { run, fetchImpl, save } = harness();
    const error = await run({ ...env, PRESEEDED_SECRET_VERSIONS: input }).then(() => null, (value: Error) => value);
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).not.toContain("private-fixture");
    expect(error?.message).not.toContain("invalid-secret-fixture");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it.each(["missing-token", "missing-google", "both-google-absent", "preview-only", "branch-only", "duplicate", "system", "unknown-type", "unknown-visibility", "missing-scope", "unknown-scope"])("pins do not bypass production metadata validation: %s", async (failure) => {
    const data = sensitiveResponse();
    if (failure === "missing-token") data.envs = data.envs.filter((item) => item.key !== "TOKEN_ENC_KEY");
    if (failure === "missing-google") data.envs = data.envs.filter((item) => item.key !== "GOOGLE_CLIENT_SECRET");
    if (failure === "both-google-absent") data.envs = data.envs.filter((item) => !item.key.startsWith("GOOGLE_"));
    if (failure === "preview-only") data.envs[2].target = ["preview"];
    if (failure === "branch-only") Object.assign(data.envs[2], { gitBranch: "some-branch" });
    if (failure === "duplicate") data.envs.push({ ...data.envs[2] });
    if (failure === "system") data.envs[2].type = "system";
    if (failure === "unknown-type") data.envs[2].type = "unknown";
    if (failure === "unknown-visibility") Object.assign(data.envs[2], { visibility: "unknown" });
    if (failure === "missing-scope") delete (data.envs[2] as Partial<typeof data.envs[number]>).target;
    if (failure === "unknown-scope") data.envs[2].target = ["production", "unknown"];
    const { run, fetchImpl, docker, save } = harness(data);
    await expect(run(preseededEnv)).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(docker).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("honors Secret visibility even when legacy type says encrypted", async () => {
    const data = response();
    Object.assign(data.envs[2], { visibility: "secret" });
    const h = harness(data);
    await expect(h.run()).rejects.toThrow("not readable plaintext");
    expect(h.docker).not.toHaveBeenCalled();
    const allowed = harness(data);
    await allowed.run({ ...env, PRESEEDED_SECRET_VERSIONS: JSON.stringify({ TOKEN_ENC_KEY: pinned.TOKEN_ENC_KEY }) });
    expect(allowed.fetchImpl.mock.calls.some(([url]) => String(url).includes("env_TOKEN_ENC_KEY"))).toBe(false);
  });

  it("requires the configured project number and rejects unrelated addVersion responses", async () => {
    const h = harness();
    await expect(h.run({ ...env, GCP_PROJECT_NUMBER: "" })).rejects.toThrow("identity is invalid");
    expect(h.fetchImpl).not.toHaveBeenCalled();
    const other = harness();
    await expect(other.run({ ...env, GCP_PROJECT_NUMBER: "987654321" })).rejects.toThrow("unexpected version reference");
    expect(other.save).not.toHaveBeenCalled();
    expect(other.docker).toHaveBeenCalledTimes(1);
    expect(parsePreseededSecretVersions(preseededEnv)).toEqual(pinned);
  });

  it("moves only allowed plaintext secrets and writes only public config with pinned references", async () => {
    const data = response();
    data.envs.push(entry("UNRELATED_SERVER_SECRET", "never-copy-this"));
    data.envs.push({ ...entry("TOKEN_ENC_KEY", "preview-only"), target: ["preview"] });
    const { run, fetchImpl, docker, save, log } = harness(data);
    await run();
    expect(fetchImpl.mock.calls[0][0]).toBe("https://api.vercel.com/v10/projects/prj_fixture/env?teamId=team_fixture");
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes("/v1/projects/prj_fixture/env/env_TOKEN_ENC_KEY?teamId=team_fixture"))).toBe(true);
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes("UNRELATED_SERVER_SECRET"))).toBe(false);
    for (const [url, options] of fetchImpl.mock.calls) {
      expect(options?.redirect).toBe("error");
      if (options?.method !== "POST") continue;
      const name = Object.entries(SECRET_NAMES).find(([, id]) => String(url).includes(`/secrets/${id}:`))?.[0];
      expect(name).toBeTruthy();
      expect(Buffer.from(JSON.parse(String(options.body)).payload.data, "base64").toString()).toBe(secretValues[name as keyof typeof secretValues]);
    }
    expect(fetchImpl.mock.calls).toHaveLength(11);
    const buildArgs = docker.mock.calls[0][0];
    expect(buildArgs.filter((arg) => arg === "--build-arg")).toHaveLength(3);
    expect(buildArgs).toContain(`NEXT_PUBLIC_SUPABASE_URL=${publicValues.NEXT_PUBLIC_SUPABASE_URL}`);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ image: digest, region: "asia-northeast1", service: "mfmf-candidate" }));
    const exposed = JSON.stringify([docker.mock.calls, save.mock.calls, log.mock.calls]);
    for (const value of [...Object.values(secretValues), "never-copy-this", env.VERCEL_TOKEN, env.GCP_ACCESS_TOKEN]) {
      expect(exposed).not.toContain(value);
    }
  });

  it.each(["TOKEN_ENC_KEY", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"])("fails before any mutation when %s is missing", async (key) => {
    const data = response();
    data.envs = data.envs.filter((item) => item.key !== key);
    const { run, fetchImpl, docker, save } = harness(data);
    await expect(run()).rejects.toThrow("Required production setting");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(docker).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it.each(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"])("fails before any mutation when one Drive setting %s is missing", async (key) => {
    const data = response();
    data.envs = data.envs.filter((item) => item.key !== key);
    const { run, docker } = harness(data);
    await expect(run()).rejects.toThrow("must be configured together");
    expect(docker).not.toHaveBeenCalled();
  });

  it("preserves disabled optional integrations without referencing empty secret containers", async () => {
    const data = response();
    data.envs = data.envs.filter((item) => !["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "SENTRY_DSN"].includes(item.key));
    const { run, fetchImpl, save } = harness(data);
    await run();
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      features: { googleDriveConfigured: false, sentryConfigured: false },
      secretVersions: { TOKEN_ENC_KEY: "projects/123456789/secrets/mfmf-token-enc-key/versions/4" },
    }));
  });

  it("uses dedicated decrypted values even when list flags and values are unusable", async () => {
    const details = response();
    const data = response();
    for (const item of data.envs) {
      item.value = "untrusted-list-ciphertext";
      delete (item as Partial<typeof item>).decrypted;
    }
    // The dedicated endpoint also documents a value:string variant without decrypted.
    for (const item of details.envs) delete (item as Partial<typeof item>).decrypted;
    const { run, fetchImpl, docker, save } = harness(data, undefined, details);
    await run();
    const mutations = fetchImpl.mock.calls.filter(([, options]) => options?.method === "POST");
    expect(mutations).toHaveLength(4);
    expect(JSON.stringify([mutations, docker.mock.calls, save.mock.calls])).not.toContain("untrusted-list-ciphertext");
    expect(Buffer.from(JSON.parse(String(mutations[0][1]?.body)).payload.data, "base64").toString()).toBe(secretValues.TOKEN_ENC_KEY);
  });

  it.each(["not-decrypted", "missing-value", "wrong-key", "wrong-id", "wrong-scope"])("fails before mutation for a %s detail response", async (failure) => {
    const details = response();
    const item = details.envs[1];
    if (failure === "not-decrypted") item.decrypted = false;
    if (failure === "missing-value") delete (item as Partial<typeof item>).value;
    if (failure === "wrong-key") item.key = "UNRELATED_SERVER_SECRET";
    if (failure === "wrong-id") item.id = "wrong-id";
    if (failure === "wrong-scope") item.target = ["preview"];
    const { run, fetchImpl, docker, save, log } = harness(response(), undefined, details);
    const error = await run().then(() => null, (value: Error) => value);
    expect(error?.message).toContain("Decrypted environment response rejected");
    expect(fetchImpl.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
    expect(docker).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    const output = JSON.stringify([error?.message, log.mock.calls]);
    expect(output).not.toContain(publicValues.NEXT_PUBLIC_SUPABASE_ANON_KEY);
    for (const value of Object.values(secretValues)) expect(output).not.toContain(value);
  });

  it("stops on a denied decrypted-value request without using list values", async () => {
    const { run, docker, save } = harness(response(), 2);
    await expect(run()).rejects.toThrow("HTTP 403");
    expect(docker).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("preserves the signup flag at build and runtime, rejecting non-boolean values", async () => {
    const data = response();
    data.envs.push({ ...entry("SIGNUP_ENABLED", "true"), type: "plain", decrypted: false });
    const { run, docker, save } = harness(data);
    await run();
    expect(docker.mock.calls[0][0]).toContain("SIGNUP_ENABLED=true");
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ env: expect.objectContaining({ SIGNUP_ENABLED: "true" }) }));
    data.envs[data.envs.length - 1].value = "yes";
    expect(() => selectProductionConfig(data)).toThrow("Optional runtime configuration");
  });

  it.each(["sensitive", "secret", "system"])("rejects unreadable %s types", async (type) => {
    const data = response();
    data.envs[2].type = type;
    const { run, docker } = harness(data);
    await expect(run()).rejects.toThrow("not readable plaintext");
    expect(docker).not.toHaveBeenCalled();
  });

  it("rejects undecrypted and duplicate settings", () => {
    const encrypted = response();
    encrypted.envs[2].decrypted = false;
    expect(() => selectProductionConfig(encrypted)).toThrow("not readable plaintext");
    const duplicate = response();
    duplicate.envs.push(entry("TOKEN_ENC_KEY", "another-value"));
    expect(() => selectProductionConfig(duplicate)).toThrow("Duplicate production setting");
  });

  it.each([{ pagination: { next: 123 } }, { hiddenProductionEnvCount: 1 }])("rejects incomplete environment listings", (extra) => {
    expect(() => selectProductionConfig({ ...response(), ...extra })).toThrow("complete visible");
  });

  it("does not silently disable an optional integration with missing environment scope", () => {
    const data = response();
    expect(() => selectProductionConfig({
      envs: data.envs.map((item) => item.key === "GOOGLE_CLIENT_ID" ? { ...item, target: undefined } : item),
    })).toThrow("scope is ambiguous");
  });

  it("rejects service_role and secret keys before Docker", async () => {
    for (const value of ["sb_secret_fixture", `header.${Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url")}.signature`]) {
      const data = response();
      data.envs[1].value = value;
      const { run, docker } = harness(data);
      await expect(run()).rejects.toThrow("privileged keys are rejected");
      expect(docker).not.toHaveBeenCalled();
    }
  });

  it("accepts a legacy anon key for the same Supabase project", () => {
    const data = response();
    data.envs[1].value = `header.${Buffer.from(JSON.stringify({ role: "anon", ref: "abcdefghijklmnopqrst" })).toString("base64url")}.signature`;
    expect(selectProductionConfig(data).publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY).toBe(data.envs[1].value);
  });

  it.each(["http://localhost:54321", "https://user:secret@abcdefghijklmnopqrst.supabase.co", "https://example.invalid"])("rejects invalid public endpoint %s", (url) => {
    const data = response(); data.envs[0].value = url;
    expect(() => selectProductionConfig(data)).toThrow("hosted project over HTTPS");
  });

  it("stops after Secret Manager failure without push, retry, or public artifact", async () => {
    const { run, docker, fetchImpl, save } = harness(response(), 9);
    await expect(run()).rejects.toThrow("HTTP 403");
    expect(fetchImpl).toHaveBeenCalledTimes(9);
    expect(docker).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
  });

  it("does not publish a manifest on a missing registry digest", async () => {
    const { run, docker, save } = harness();
    docker.mockImplementation(async () => "[]");
    await expect(run()).rejects.toThrow("image digest is missing");
    expect(save).not.toHaveBeenCalled();
  });

  it("requires the manual main execution context before requests", async () => {
    const { run, fetchImpl } = harness();
    await expect(run({ ...env, GITHUB_REF: "refs/pull/1/merge" })).rejects.toThrow("manual main");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps WIF authentication restricted to the intended Docker registry", () => {
    expect(dockerCredential("get", "asia-northeast1-docker.pkg.dev\n", "short-lived")).toEqual({ Username: "oauth2accesstoken", Secret: "short-lived" });
    expect(() => dockerCredential("get", "example.invalid", "short-lived")).toThrow("rejected");
    expect(() => dockerCredential("store", "asia-northeast1-docker.pkg.dev", "short-lived")).toThrow("rejected");
  });
});
