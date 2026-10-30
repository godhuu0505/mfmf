import { afterEach, describe, expect, it, vi } from "vitest";
import { errorType, parseBrowserTelemetry, privateErrorEvent, privateMetric, sentryEndpoint, telemetryRoute } from "@/lib/telemetry/privacy";
import { createBudget, createTelemetryBudgets } from "@/lib/telemetry/limits";
import { createBrowserReporter } from "@/lib/telemetry/client";
const secret = "private-fixture-token-email-photo-record";
const dsn = `https://${"a".repeat(32)}@o123.ingest.us.sentry.io/456`;
afterEach(() => vi.unstubAllEnvs());
describe("privacy projection", () => {
  it.each([`/records/${secret}?code=${secret}#${secret}`, `/invite/${secret}`, `/share/${secret}`, `/pets/${secret}`, `/auth/${secret}`, `/api/${secret}`, `https://evil.example/${secret}`, null, {}, "/".repeat(3000)])("never returns an unknown path or URL: %s", (path) => {
    expect(telemetryRoute(path)).not.toContain(secret);
    expect(telemetryRoute(path)).not.toContain("evil");
  });
  it("retains fixed route labels and replaces dynamic segments", () => {
    expect(telemetryRoute("/records/new?secret=marker")).toBe("/records/new");
    expect(telemetryRoute("/records/uuid")).toBe("/records/[id]");
    expect(telemetryRoute("/calendar")).toBe("/calendar");
  });
  it("rebuilds events instead of attempting partial redaction", () => {
    const event = privateErrorEvent({ message: secret, logentry: { message: secret }, user: { email: secret }, request: { url: secret, headers: { cookie: secret }, data: secret },
      breadcrumbs: [{ message: secret }], contexts: { trace: { trace_id: secret } }, extra: { secret }, attachments: [secret], modules: { secret },
      transaction: secret, server_name: secret, environment: secret, release: secret, fingerprint: [secret],
      exception: { values: [{ type: secret, value: secret, stacktrace: { frames: [{ filename: secret, vars: { secret } }] } }] },
      tags: { route: `/records/${secret}`, category: secret, secret } });
    expect(JSON.stringify(event)).not.toContain(secret);
    expect(event?.tags).toEqual({ category: "server", route: "/records/[id]" });
    expect(event?.exception.values[0]).toEqual({ type: "Error", value: "mfmf server failure; details withheld" });
    expect(Object.keys(event!)).toEqual(["type", "level", "platform", "environment", "sdk", "exception", "fingerprint", "tags"]);
  });
  it.each([undefined, null, {}, { settings: { infer_ip: "auto" } }, { settings: { infer_ip: "legacy" } },
    { name: secret, version: secret, packages: [secret], settings: { infer_ip: "never", extra: secret } }])("always prevents IP inference with a fresh fixed SDK setting", (sdk) => {
    const event = privateErrorEvent({ sdk, user: { ip_address: "{{auto}}", geo: { city: secret } } });
    expect(event?.sdk).toEqual({ settings: { infer_ip: "never" } });
    expect(event).not.toHaveProperty("user");
    expect(JSON.stringify(event)).not.toContain(secret);
  });
  it.each(["transaction", "profile", "replay_event", "feedback"])("drops %s", (type) => expect(privateErrorEvent({ type, message: secret })).toBeNull());
  it("keeps useful fixed error classes without reading custom messages", () => {
    expect(errorType(new TypeError(secret))).toBe("TypeError");
    const error = new Error(secret); error.name = secret; expect(errorType(error)).toBe("Error");
    expect(errorType({ name: "TypeError", message: secret })).toBe("Error");
  });
  it("rejects unknown telemetry fields even if the known fields are valid", () => {
    expect(parseBrowserTelemetry({ kind: "error", category: "render", route: "/", message: secret })).toBeNull();
    expect(parseBrowserTelemetry({ kind: "vital", name: "LCP", value: 10, route: "/", id: secret })).toBeNull();
  });
  it.each([NaN, Infinity, -1, 120_001, "12", null])("rejects invalid metric value %s", (value) => expect(parseBrowserTelemetry({ kind: "vital", name: "LCP", value })).toBeNull());
  it("caps CLS separately and projects arbitrary rating/navigation values", () => {
    expect(parseBrowserTelemetry({ kind: "vital", name: "CLS", value: 11 })).toBeNull();
    expect(parseBrowserTelemetry({ kind: "vital", name: "LCP", value: 42.12345, route: `/records/${secret}`, rating: secret, navigationType: secret }))
      .toEqual({ kind: "vital", name: "LCP", value: 42.123, route: "/records/[id]", rating: "unknown", navigationType: "unknown" });
  });
  it("drops all metrics other than the five fixed distributions", () => {
    expect(privateMetric({ name: "secret.metric", value: 1, type: "distribution" })).toBeNull();
    expect(privateMetric({ name: "web_vital.lcp", value: 1, type: "counter" })).toBeNull();
    const projected = privateMetric({ name: "web_vital.lcp", value: 1, type: "distribution", unit: secret,
      attributes: { route: "/", rating: "good", navigation_type: "navigate", user: secret } });
    expect(JSON.stringify(projected)).not.toContain(secret);
  });
  it.each([undefined, "", "http://x@o1.ingest.sentry.io/1", `https://${"a".repeat(32)}@evil.example/1`, `${dsn}?next=evil`, `${dsn}#secret`, `${dsn}/extra`, `https://${"a".repeat(32)}:secret@o1.ingest.sentry.io/1`])("rejects unsafe DSN", (value) => expect(sentryEndpoint(value)).toBeNull());
  it("pins a SaaS ingest URL without userinfo", () => expect(sentryEndpoint(dsn)).toBe(`https://o123.ingest.us.sentry.io/api/456/envelope/?sentry_version=7&sentry_key=${"a".repeat(32)}`));
});
describe("bounded traffic", () => {
  it("uses fixed counters rather than unbounded user/key maps", () => {
    let now = 0; const allow = createBudget(2, 100, () => now);
    expect([allow(), allow(), allow()]).toEqual([true, true, false]); now = 100; expect(allow()).toBe(true);
  });
  it("caps daily events even across minute windows", () => {
    let now = 0; const budget = createTelemetryBudgets(() => now);
    for (let i = 0; i < 20; i++) { expect([budget.error(), budget.error(), budget.error(), budget.error()]).toEqual([true, true, true, false]); now += 60_000; }
    expect(budget.error()).toBe(false); now = 86_400_000; expect(budget.error()).toBe(true);
  });
  it("does no browser requests during development", async () => {
    vi.stubEnv("NODE_ENV", "development"); const fetchImpl = vi.fn(); const reporter = createBrowserReporter({ fetchImpl });
    await reporter.error("render"); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("caches disabled configuration and never posts telemetry without a DSN", async () => {
    vi.stubEnv("NODE_ENV", "production"); const fetchImpl = vi.fn().mockResolvedValue(Response.json({ enabled: false }));
    const reporter = createBrowserReporter({ fetchImpl, random: () => 0, path: () => "/" });
    await reporter.error("render"); await reporter.error("global-render"); await reporter.vital({ name: "LCP", value: 10 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("fails closed for anonymous, malformed, or unavailable configuration", async () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const response of [new Response(null, { status: 204 }), new Response("invalid")]) {
      const fetchImpl = vi.fn().mockResolvedValue(response); await createBrowserReporter({ fetchImpl, path: () => "/" }).error("render"); expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });
  it("samples performance only, deduplicates, and caps browser exceptions", async () => {
    vi.stubEnv("NODE_ENV", "production"); const fetchImpl = vi.fn().mockImplementation(async (_url, options) => options.method ? new Response(null, { status: 204 }) : Response.json({ enabled: true }));
    const reporter = createBrowserReporter({ fetchImpl, random: () => 0.5, path: () => `/records/${secret}?token=${secret}` });
    await reporter.vital({ name: "LCP", value: 10 });
    for (const category of ["render", "render", "global-render", "unhandled-error", "unhandled-rejection"] as const) await reporter.error(category);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    for (const [_url, options] of fetchImpl.mock.calls.slice(1)) {
      expect(options.referrerPolicy).toBe("no-referrer"); expect(options.redirect).toBe("error"); expect(options.body).not.toContain(secret);
      expect(JSON.parse(options.body).route).toBe("/records/[id]");
    }
  });
  it("emits each of five vitals at most once per sampled document, never metric IDs", async () => {
    vi.stubEnv("NODE_ENV", "production"); const fetchImpl = vi.fn().mockImplementation(async (_url, options) => options.method ? new Response(null, { status: 204 }) : Response.json({ enabled: true }));
    const reporter = createBrowserReporter({ fetchImpl, random: () => 0, path: () => "/" });
    for (let i = 0; i < 2; i++) for (const name of ["CLS", "LCP", "INP", "FCP", "TTFB"]) await reporter.vital({ name, value: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });
});
