import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { addCloudRunAuthUrls, CALLBACK_URLS } from "../../scripts/add-cloud-run-auth-urls.mjs";

const marker = "PRIVATE_FIXTURE_NEVER_PRINT";
const env = {
  GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "workflow_dispatch",
  SUPABASE_ACCESS_TOKEN: "fixture-access-token", SUPABASE_PROJECT_ID: "abcdefghijklmnopqrst",
};
const applyEnv = { ...env, SUPABASE_AUTH_URLS_APPLY: "true" };
const initial = {
  site_url: "https://existing.example",
  uri_allow_list: " https://existing.example/** ,http://localhost:3000/**,https://existing.example/** ",
  smtp_pass: marker, external_google_secret: marker,
};
const updatedList = `${initial.uri_allow_list},${CALLBACK_URLS.join(",")}`;
const endpoint = "https://api.supabase.com/v1/projects/abcdefghijklmnopqrst/config/auth";

function replies(configs: unknown[]) {
  return vi.fn(async () => {
    if (!configs.length) throw new Error("Unexpected extra request");
    return Response.json(configs.shift());
  });
}

async function expectFailure(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(() => undefined, (error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

describe("fixed Cloud Run auth URL additions", () => {
  it("defaults to a single read-only GET plan containing only the fixed URLs", async () => {
    const fetchImpl = replies([initial]);
    const summary = await addCloudRunAuthUrls({ env, fetchImpl });
    expect(summary).toEqual({ mode: "plan", status: "planned", additions: [
      "https://mfmf-candidate-wspqvmhj6q-an.a.run.app/auth/callback",
      "https://mfmf-candidate-wspqvmhj6q-an.a.run.app/auth/callback?next=/reset-password",
    ] });
    expect(JSON.stringify(summary)).not.toContain(marker);
    expect(JSON.stringify(summary)).not.toContain(initial.site_url);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith(endpoint, {
      method: "GET", headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` },
      redirect: "error", signal: expect.any(AbortSignal),
    });
  });

  it("applies exactly GET, GET, PATCH, GET, retaining the original list and sending no other config fields", async () => {
    const fetchImpl = replies([initial, initial, { smtp_pass: marker }, { ...initial, uri_allow_list: updatedList }]);
    expect(await addCloudRunAuthUrls({ env: applyEnv, fetchImpl })).toEqual({
      mode: "apply", status: "applied", added: 2, siteUrlUnchanged: true, existingAllowlistPreserved: true,
    });
    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([, options]) => options.method)).toEqual(["GET", "GET", "PATCH", "GET"]);
    for (const [url, options] of calls) {
      expect(url).toBe(endpoint);
      expect(options.redirect).toBe("error");
      expect(options.signal).toBeInstanceOf(AbortSignal);
      if (options.method === "GET") expect(options.body).toBeUndefined();
    }
    expect(JSON.parse(String(calls[2][1].body))).toEqual({ uri_allow_list: updatedList });
    expect(String(calls[2][1].body)).not.toContain(marker);
    expect(calls[2][1].headers).toEqual({ Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, "Content-Type": "application/json" });
  });

  it.each([undefined, "false", "true"])("is idempotent with both exact entries present (apply=%s)", async (apply) => {
    const fetchImpl = replies([{ ...initial, uri_allow_list: ` ${CALLBACK_URLS[1]} ,${CALLBACK_URLS[0]},${CALLBACK_URLS[0]}` }]);
    expect(await addCloudRunAuthUrls({ env: { ...env, SUPABASE_AUTH_URLS_APPLY: apply }, fetchImpl })).toMatchObject({ status: "unchanged", added: 0 });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("appends only the missing exact URL, without treating wildcard or different query encodings as an exact entry", async () => {
    const config = { ...initial, uri_allow_list: `${CALLBACK_URLS[0]},${CALLBACK_URLS[0]}?next=%2Freset-password` };
    const expected = `${config.uri_allow_list},${CALLBACK_URLS[1]}`;
    const fetchImpl = replies([config, config, {}, { ...config, uri_allow_list: expected }]);
    expect(await addCloudRunAuthUrls({ env: applyEnv, fetchImpl })).toMatchObject({ added: 1 });
    expect(JSON.parse(String((fetchImpl.mock.calls as unknown as [string, RequestInit][])[2][1].body))).toEqual({ uri_allow_list: expected });
  });

  it.each([null, "", "  ", "https://existing.example/**,"])("preserves empty/null/trailing-separator list semantics: %s", async (list) => {
    const config = { site_url: null, uri_allow_list: list };
    const expected = `${list ?? ""}${list ? "," : ""}${CALLBACK_URLS.join(",")}`;
    const fetchImpl = replies([config, config, {}, { ...config, uri_allow_list: expected }]);
    await expect(addCloudRunAuthUrls({ env: applyEnv, fetchImpl })).resolves.toMatchObject({ status: "applied" });
    expect(JSON.parse(String((fetchImpl.mock.calls as unknown as [string, RequestInit][])[2][1].body))).toEqual({ uri_allow_list: expected });
  });

  it.each([
    { GITHUB_REF: "refs/heads/other" }, { GITHUB_ACTIONS: "false" }, { GITHUB_EVENT_NAME: "push" },
    { SUPABASE_PROJECT_ID: "../../another-project" }, { SUPABASE_PROJECT_ID: "ABCDEFGHIJKLMNOPQRST" },
    { SUPABASE_ACCESS_TOKEN: "" }, { SUPABASE_ACCESS_TOKEN: "bad\ntoken" },
    { SUPABASE_AUTH_URLS_APPLY: "TRUE" }, { SUPABASE_AUTH_URLS_APPLY: "1" }, { SUPABASE_AUTH_URLS_APPLY: marker },
  ])("rejects invalid execution context before all network requests: %j", async (override) => {
    const fetchImpl = vi.fn();
    const error = await expectFailure(addCloudRunAuthUrls({ env: { ...applyEnv, ...override }, fetchImpl }));
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain(marker);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["site_url", "uri_allow_list"])("stops before PATCH if %s changes, even if change is only whitespace", async (field) => {
    const fetchImpl = replies([initial, { ...initial, [field]: `${initial[field as keyof typeof initial]} ` }]);
    await expect(addCloudRunAuthUrls({ env: applyEnv, fetchImpl })).rejects.toThrow("no PATCH sent");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each(["site_url", "uri_allow_list"])("fails verification without retry or rollback if %s differs after PATCH", async (field) => {
    const fetchImpl = replies([initial, initial, {}, { ...initial, uri_allow_list: updatedList, [field]: marker }]);
    const error = await expectFailure(addCloudRunAuthUrls({ env: applyEnv, fetchImpl }));
    expect(error.message).toContain("PATCH was attempted");
    expect(error.message).not.toContain(marker);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it.each([{}, null, [], { site_url: "", uri_allow_list: [] }, { site_url: 42, uri_allow_list: "" },
    { site_url: "", uri_allow_list: "x".repeat(32_769) },
    { site_url: "", uri_allow_list: Array(201).fill("x").join(",") },
    { site_url: "", uri_allow_list: "x".repeat(32_768) },
    { site_url: "", uri_allow_list: Array(199).fill("x").join(",") },
  ])("rejects malformed config or an append exceeding limits before any write", async (config) => {
    const fetchImpl = replies([config]);
    await expect(addCloudRunAuthUrls({ env: applyEnv, fetchImpl })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([0, 1, 2, 3])("never retries a failed request at operation %i or leaks its error", async (failureIndex) => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      if (call++ === failureIndex) throw new Error(marker);
      return Response.json(initial);
    });
    const error = await expectFailure(addCloudRunAuthUrls({ env: applyEnv, fetchImpl }));
    expect(error.message).not.toContain(marker);
    expect(error.message).not.toContain(env.SUPABASE_ACCESS_TOKEN);
    expect(fetchImpl).toHaveBeenCalledTimes(failureIndex + 1);
    if (failureIndex >= 2) expect(error.message).toContain("PATCH was attempted");
  });

  it.each(["http", "redirect", "empty", "json", "oversized", "stream"])("withholds private %s body/error details", async (failure) => {
    const fetchImpl = vi.fn(async () => {
      if (failure === "http" || failure === "redirect") return new Response(marker, { status: failure === "http" ? 403 : 302 });
      if (failure === "empty") return new Response(null);
      if (failure === "json") return new Response(marker);
      if (failure === "stream") return new Response(new ReadableStream({ start(controller) { controller.error(new Error(marker)); } }));
      return new Response(marker.repeat(20_000));
    });
    const error = await expectFailure(addCloudRunAuthUrls({ env: applyEnv, fetchImpl }));
    expect(error.message).not.toContain(marker);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each(["success", "error"])("CLI %s output withholds provider values, original settings, and arbitrary exceptions", (scenario) => {
    const source = scenario === "success"
      ? `globalThis.fetch=async()=>Response.json(${JSON.stringify(initial)})`
      : `globalThis.fetch=async()=>{throw new Error(${JSON.stringify(marker)})}`;
    const result = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(source)}`,
      fileURLToPath(new URL("../../scripts/add-cloud-run-auth-urls.mjs", import.meta.url))], { env: { ...env, NODE_ENV: "test" }, encoding: "utf8" });
    expect(result.status).toBe(scenario === "success" ? 0 : 1);
    const output = result.stdout + result.stderr;
    expect(output).not.toContain(marker);
    expect(output).not.toContain(env.SUPABASE_ACCESS_TOKEN);
    expect(output).not.toContain(initial.site_url);
    expect(output).not.toContain("smtp");
  });
});
