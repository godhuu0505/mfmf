import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const sentry = vi.hoisted(() => ({ captureEvent: vi.fn(), metrics: { distribution: vi.fn() }, flush: vi.fn().mockResolvedValue(true) }));
vi.mock("@sentry/nextjs", () => sentry);
const dsn = `https://${"a".repeat(32)}@o123.ingest.us.sentry.io/456`;
let route: typeof import("@/app/api/vitals/route");
function request(body: unknown, headers = {}) { return new Request("https://internal.example/api/vitals", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", ...headers } }); }
beforeEach(async () => { vi.resetModules(); vi.clearAllMocks(); vi.stubEnv("SENTRY_DSN", dsn); route = await import("@/app/api/vitals/route"); });
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
describe("telemetry route boundaries", () => {
  it("returns only enabled/no-store, never DSN", async () => { const response = route.GET(); expect(await response.json()).toEqual({ enabled: true }); expect(response.headers.get("cache-control")).toBe("private, no-store"); });
  it("drops telemetry before reading body when unconfigured", async () => {
    vi.stubEnv("SENTRY_DSN", ""); expect(await route.GET().json()).toEqual({ enabled: false });
    expect((await route.POST(request({ kind: "error", category: "render", route: "/" }))).status).toBe(204); expect(sentry.captureEvent).not.toHaveBeenCalled(); expect(sentry.flush).not.toHaveBeenCalled();
  });
  it.each(["cross-site", "same-site", "none"])("rejects %s even with valid payload", async (site) => { expect((await route.POST(request({ kind: "error", category: "render" }, { "sec-fetch-site": site }))).status).toBe(403); expect(sentry.captureEvent).not.toHaveBeenCalled(); });
  it("rejects non-JSON bodies", async () => expect((await route.POST(request({}, { "content-type": "text/plain" }))).status).toBe(415));
  it("rejects unknown fields and values before capture", async () => {
    for (const payload of [{ kind: "error", category: "server" }, { kind: "error", category: "render", stack: "secret" }, { kind: "vital", name: "LCP", value: -1 }]) expect((await route.POST(request(payload))).status).toBe(400);
    expect(sentry.captureEvent).not.toHaveBeenCalled(); expect(sentry.metrics.distribution).not.toHaveBeenCalled();
  });
  it("bounds chunked bytes without trusting Content-Length", async () => {
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(1025))); controller.close(); } });
    const req = new Request("https://internal.example/api/vitals", { method: "POST", body: stream, duplex: "half", headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", "content-length": "1" } } as RequestInit);
    expect((await route.POST(req)).status).toBe(413); expect(sentry.flush).not.toHaveBeenCalled();
  });
  it("bounds slow body reads", async () => {
    vi.useFakeTimers(); const req = new Request("https://internal.example/api/vitals", { method: "POST", body: new ReadableStream({ start() {} }), duplex: "half", headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" } } as RequestInit);
    const result = route.POST(req); await vi.advanceTimersByTimeAsync(2001); expect((await result).status).toBe(400);
  });
  it("projects client exception and bounds flush", async () => {
    expect((await route.POST(request({ kind: "error", category: "render", route: "/records/private-token?secret=1" }))).status).toBe(204);
    expect(sentry.captureEvent).toHaveBeenCalledWith({ tags: { category: "render", route: "/records/[id]" }, exception: { values: [{ type: "Error" }] } });
    expect(sentry.flush).toHaveBeenCalledWith(500);
  });
  it("bounds rating/navigation and does not flush rejected metrics", async () => {
    await route.POST(request({ kind: "vital", name: "LCP", value: 42, route: "/", rating: "secret", navigationType: "secret" }));
    expect(sentry.metrics.distribution).toHaveBeenCalledWith("web_vital.lcp", 42, { unit: "millisecond", attributes: { route: "/", rating: "unknown", navigation_type: "unknown" } });
  });
  it("caps inbound requests for this process", async () => {
    for (let i = 0; i < 60; i++) expect((await route.POST(request({ kind: "error", category: "render", route: "/" }))).status).toBe(204);
    expect((await route.POST(request({ kind: "error", category: "render", route: "/" }))).status).toBe(429);
    expect(sentry.captureEvent).toHaveBeenCalledTimes(60);
  });
});
