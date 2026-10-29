import { afterEach, describe, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/nextjs";
import { privateEnvelope, privateTransport } from "@/lib/telemetry/transport";
import { privateErrorEvent, privateMetric } from "@/lib/telemetry/privacy";
const dsn = `https://${"a".repeat(32)}@o123.ingest.us.sentry.io/456`;
const marker = "PRIVATE_FIXTURE_PHOTO_COOKIE_TOKEN";
type Envelope = Parameters<typeof privateEnvelope>[0];
afterEach(async () => { await Sentry.close(100); vi.restoreAllMocks(); });
describe("last outbound privacy boundary", () => {
  it("drops attachment, transaction, log, replay and envelope trace/DSN headers", () => {
    const envelope = [{ trace: { secret: marker }, dsn: marker }, [
      [{ type: "event" }, { event_id: "a".repeat(32), message: marker, request: { url: marker }, sdk: { name: marker, settings: { infer_ip: "auto" } }, tags: { route: `/records/${marker}`, category: "server" } }],
      ...["attachment", "transaction", "log", "replay_recording", "session", "profile", "feedback", "check_in", "client_report"].map((type) => [{ type }, marker]),
    ]] as unknown as Envelope;
    const result = privateEnvelope(envelope)!;
    expect(result[1]).toHaveLength(1); expect(JSON.stringify(result)).not.toContain(marker); expect(result[0]).not.toHaveProperty("trace"); expect(result[0]).not.toHaveProperty("dsn");
    expect(result[1][0][1]).toHaveProperty("sdk", { settings: { infer_ip: "never" } });
  });
  it("reprojects SDK serialized metrics and removes scope/trace identifiers", () => {
    const envelope = [{ trace: marker }, [[{ type: "trace_metric" }, { ingest_settings: { infer_ip: "auto" }, items: [
      { name: "web_vital.lcp", type: "distribution", value: 10, trace_id: marker, span_id: marker, timestamp: marker,
        attributes: { route: { type: "string", value: `/records/${marker}` }, rating: { type: "string", value: "good" }, navigation_type: { type: "string", value: marker }, secret: { type: "string", value: marker } } },
      { name: marker, value: 1, type: "counter" },
    ] }]]] as unknown as Envelope;
    const result = privateEnvelope(envelope)!; expect(JSON.stringify(result)).not.toContain(marker);
    expect(result[1]).toHaveLength(1); expect(result[1][0][1]).toMatchObject({ ingest_settings: { infer_ip: "never", infer_user_agent: "never" }, items: [{ attributes: { navigation_type: { value: "unknown" } } }] });
  });
  it("does not transmit dropped envelopes or exceeded budgets", () => {
    const envelope = [{}, [[{ type: "event" }, {}]]] as unknown as Envelope;
    expect(privateEnvelope(envelope, { error: () => false, metric: () => false })).toBeNull();
    expect(privateEnvelope([{}, [[{ type: "attachment", filename: marker, length: 1 }, marker]]] as unknown as Envelope)).toBeNull();
  });
  it("pins HTTP destination, omits credentials, rejects redirect and honors rate limits", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 429, headers: { "retry-after": "60" } }));
    const transport = privateTransport(dsn, fetchImpl)({ recordDroppedEvent: () => {}, bufferSize: 4 });
    const envelope = [{}, [[{ type: "event" }, { message: marker }]]] as unknown as Envelope;
    await transport.send(envelope); await transport.send(envelope);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]; expect(url).toMatch(/^https:\/\/o123\.ingest\.us\.sentry\.io\/api\/456\/envelope\//);
    expect(init).toMatchObject({ method: "POST", credentials: "omit", referrerPolicy: "no-referrer", redirect: "error" });
    expect(String(init.body)).not.toContain(marker); expect(init.headers).toEqual({ "content-type": "application/x-sentry-envelope" });
  });
  it("runs real SDK capture and metric serialization without leaking poisoned scope", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    Sentry.init({ dsn, defaultIntegrations: false, skipOpenTelemetrySetup: true, sendClientReports: false,
      enableLogs: false, enableMetrics: true, beforeSend: privateErrorEvent, beforeSendMetric: privateMetric, transport: privateTransport(dsn, fetchImpl) });
    Sentry.withScope((scope) => {
      scope.setUser({ email: marker, id: marker }); scope.setExtra("secret", marker); scope.setTag("secret", marker);
      scope.addAttachment({ filename: marker, data: marker });
      Sentry.captureException(new TypeError(marker));
      Sentry.metrics.distribution("web_vital.lcp", 123, { unit: "millisecond", attributes: { route: "/", rating: "good", navigation_type: "navigate", secret: marker } });
    });
    expect(await Sentry.flush(2000)).toBe(true);
    const bodies = fetchImpl.mock.calls.map(([, init]) => String(init.body));
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    expect(bodies.join()).not.toContain(marker); expect(bodies.join()).toContain("web_vital.lcp"); expect(bodies.join()).toContain("TypeError");
    expect(bodies.join()).not.toContain('"attachment"'); expect(bodies.join()).not.toContain('"user"');
    const eventBody = bodies.find((body) => body.split("\n")[1] === '{"type":"event"}')!;
    const sentEvent = JSON.parse(eventBody.split("\n")[2]);
    expect(sentEvent.sdk).toEqual({ settings: { infer_ip: "never" } });
    expect(Object.keys(sentEvent.sdk)).toEqual(["settings"]);
    expect(sentEvent).not.toHaveProperty("user");
  });
});
