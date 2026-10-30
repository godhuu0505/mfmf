import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const sdk = vi.hoisted(() => ({ init: vi.fn(), captureEvent: vi.fn(), flush: vi.fn().mockResolvedValue(true) }));
vi.mock("@sentry/nextjs", () => sdk);
import { register, onRequestError } from "@/instrumentation";
const dsn = `https://${"a".repeat(32)}@o123.ingest.us.sentry.io/456`;
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("SENTRY_DSN", dsn); vi.stubEnv("NEXT_RUNTIME", "nodejs"); });
afterEach(() => vi.unstubAllEnvs());
describe("explicit capture only", () => {
  it.each(["", "https://evil.example/secret"])("never initializes invalid/missing DSN", async (value) => { vi.stubEnv("SENTRY_DSN", value); await register(); expect(sdk.init).not.toHaveBeenCalled(); });
  it.each(["nodejs", "edge"])("disables automatic data collection in %s", async (runtime) => {
    vi.stubEnv("NEXT_RUNTIME", runtime); vi.stubEnv("SENTRY_TRACES_SAMPLE_RATE", "1"); await register();
    const options = sdk.init.mock.calls[0][0];
    expect(options).toMatchObject({ defaultIntegrations: false, skipOpenTelemetrySetup: true, enableLogs: false, sendDefaultPii: false, sendClientReports: false, maxBreadcrumbs: 0 });
    expect(options).not.toHaveProperty("tracesSampleRate"); expect(options).not.toHaveProperty("tracesSampler");
    expect(options.beforeSendTransaction({})).toBeNull(); expect(options.beforeSendLog({})).toBeNull(); expect(options.beforeBreadcrumb({})).toBeNull();
  });
  it("never gives Next request, error message, stack or private route to the SDK", async () => {
    const marker = "PRIVATE_FIXTURE_AUTH_PHOTO_RECORD";
    const error = new TypeError(marker); error.stack = marker;
    await onRequestError(error, { path: marker, method: marker, headers: { cookie: marker } }, { routerKind: marker, routePath: `/records/${marker}`, routeType: marker });
    expect(JSON.stringify(sdk.captureEvent.mock.calls)).not.toContain(marker);
    expect(sdk.captureEvent).toHaveBeenCalledWith({ exception: { values: [{ type: "TypeError" }] }, tags: { category: "server", route: "/records/[id]" } });
    expect(sdk.flush).toHaveBeenCalledWith(3_500);
  });
  it("does not propagate telemetry failure", async () => {
    sdk.flush.mockRejectedValueOnce(new Error("private provider body"));
    await expect(onRequestError(new Error(), { path: "/", method: "GET", headers: {} }, { routerKind: "App Router", routePath: "/", routeType: "render" })).resolves.toBeUndefined();
  });
});
