import { describe, expect, it, vi } from "vitest";
import { inspectAuthUrls, summarizeAuthUrls } from "../../scripts/inspect-supabase-auth-urls.mjs";

const marker = "PRIVATE_FIXTURE_NEVER_PRINT";
const env = {
  GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "workflow_dispatch",
  SUPABASE_ACCESS_TOKEN: "fixture-access-token", SUPABASE_PROJECT_ID: "abcdefghijklmnopqrst",
};

describe("Supabase auth URL inspection", () => {
  it("returns only needed public URL metadata and never provider, SMTP, URL credentials, queries, or tokens", () => {
    const summary = summarizeAuthUrls({
      site_url: `https://public.example/?key=${marker}#${marker}`,
      uri_allow_list: [
        "http://localhost:3000/auth/callback",
        `https://candidate.run.app/auth/callback?next=/reset-password&secret=${marker}`,
        "https://*.vercel.app/**",
        `https://${marker}:${marker}@private.example/auth/callback`,
        `https://public.example/token/${marker}`,
      ].join(","),
      smtp_pass: marker, external_google_secret: marker, unknown_future_key: marker,
    });
    expect(summary.site_url).toEqual({ kind: "url-unverified", origin: "https://public.example", pathname: "/", hasQuery: true, hasFragment: true });
    expect(summary.uri_allow_list[0]).toMatchObject({ origin: "http://localhost:3000", pathname: "/auth/callback" });
    expect(summary.uri_allow_list[1]).toMatchObject({ kind: "pattern-unverified", origin: "https://candidate.run.app", pathname: "/auth/callback", hasQuery: true });
    expect(summary.uri_allow_list[2]).toMatchObject({ kind: "pattern-unverified", origin: "https://*.vercel.app", pathname: "/**" });
    expect(summary.uri_allow_list[3]).toEqual({ kind: "credentials-withheld" });
    expect(summary.uri_allow_list[4]).toMatchObject({ pathname: "[other-path-withheld]" });
    expect(summary.matching).toBe("not-evaluated");
    expect(JSON.stringify(summary)).not.toContain(marker);
    expect(JSON.stringify(summary)).not.toContain("smtp");
  });

  it("keeps wildcard/query matching unverified and withholds unsupported patterns or schemes", () => {
    const summary = summarizeAuthUrls({ site_url: null, uri_allow_list: "http://localhost:3000/?,https://[a-z].example/**,custom-app://callback,https://public.example/\\bad" });
    expect(summary.site_url).toEqual({ kind: "not-configured" });
    expect(summary.uri_allow_list[0]).toMatchObject({ kind: "pattern-unverified" });
    expect(summary.uri_allow_list.slice(1)).toEqual([{ kind: "unsupported-url-withheld" }, { kind: "unsupported-scheme-withheld" }, { kind: "unsupported-url-withheld" }]);
    expect(summarizeAuthUrls({ site_url: "", uri_allow_list: null }).uri_allow_list).toEqual([]);
  });

  it.each([{}, null, [], { site_url: 12, uri_allow_list: "" }, { site_url: "", uri_allow_list: [] }])("rejects unexpected schema without body output", (body) => {
    expect(() => summarizeAuthUrls(body)).toThrow("unexpected schema");
  });

  it("limits redirect list size and entry count", () => {
    expect(() => summarizeAuthUrls({ site_url: "", uri_allow_list: marker.repeat(2000) })).toThrow("too large");
    expect(() => summarizeAuthUrls({ site_url: "", uri_allow_list: Array(201).fill("https://example.com").join(",") })).toThrow("too large");
  });

  it("makes exactly one GET to the fixed API with no redirect or follow-up writes", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ site_url: "https://public.example", uri_allow_list: "" }));
    await inspectAuthUrls({ env, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith("https://api.supabase.com/v1/projects/abcdefghijklmnopqrst/config/auth", {
      method: "GET", headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` }, redirect: "error", signal: expect.any(AbortSignal),
    });
  });

  it.each(["ref", "event", "actions", "token", "project"])("refuses invalid %s before any request", async (failure) => {
    const invalid = { ...env };
    if (failure === "ref") invalid.GITHUB_REF = "refs/heads/other";
    if (failure === "event") invalid.GITHUB_EVENT_NAME = "push";
    if (failure === "actions") invalid.GITHUB_ACTIONS = "false";
    if (failure === "token") invalid.SUPABASE_ACCESS_TOKEN = "bad\ntoken";
    if (failure === "project") invalid.SUPABASE_PROJECT_ID = "../../another-project";
    const fetchImpl = vi.fn();
    await expect(inspectAuthUrls({ env: invalid, fetchImpl })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["http", "redirect", "network", "json", "oversized", "stream"])("withholds private %s failure details and never retries", async (failure) => {
    const fetchImpl = vi.fn(async () => {
      if (failure === "network") throw new Error(marker);
      if (failure === "http" || failure === "redirect") return new Response(marker, { status: failure === "http" ? 403 : 302 });
      if (failure === "json") return new Response(marker);
      if (failure === "stream") return new Response(new ReadableStream({ start(controller) { controller.error(new Error(marker)); } }));
      return new Response(marker.repeat(20_000));
    });
    const error = await inspectAuthUrls({ env, fetchImpl }).then(() => null, (value: Error) => value);
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).not.toContain(marker);
    expect(error?.message).not.toContain(env.SUPABASE_ACCESS_TOKEN);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
