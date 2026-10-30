import * as Sentry from "@sentry/nextjs";
import { createTelemetryBudgets } from "./limits";
import { privateErrorEvent, privateMetric, sentryEndpoint } from "./privacy";

type Transport = ReturnType<typeof Sentry.createTransport>;
type Envelope = Parameters<Transport["send"]>[0];
type TransportOptions = Parameters<typeof Sentry.createTransport>[0];

/** Final envelope boundary also removes attachments, SDK scope and trace headers. */
export function privateEnvelope(envelope: Envelope, budget = { error: () => true, metric: () => true }): Envelope | null {
  const items: Array<Envelope[1][number]> = [];
  for (const [header, payload] of envelope[1].slice(0, 50)) {
    if (header.type === "event") {
      const event = privateErrorEvent(payload);
      if (event && budget.error()) items.push([{ type: "event" }, event]);
    } else if (header.type === "trace_metric" && payload && typeof payload === "object" && "items" in payload && Array.isArray(payload.items)) {
      const metrics = [];
      for (const raw of payload.items.slice(0, 50)) {
        if (!raw || typeof raw !== "object") continue;
        const attributes: Record<string, unknown> = {};
        for (const key of ["route", "rating", "navigation_type"]) {
          const value = raw.attributes?.[key];
          attributes[key] = value && typeof value === "object" && value.type === "string" ? value.value : undefined;
        }
        const metric = privateMetric({ ...raw, attributes });
        if (!metric || !budget.metric()) continue;
        metrics.push({ ...metric, timestamp: Date.now() / 1000, trace_id: crypto.randomUUID().replaceAll("-", ""),
          attributes: Object.fromEntries(Object.entries(metric.attributes).map(([key, value]) => [key, { type: "string" as const, value }])) });
      }
      if (metrics.length) items.push([{ type: "trace_metric", item_count: metrics.length, content_type: "application/vnd.sentry.items.trace-metric+json" },
        { version: 2, items: metrics, ingest_settings: { infer_ip: "never", infer_user_agent: "never" } }]);
    }
  }
  const event = items.find(([header]) => header.type === "event")?.[1] as { event_id?: string } | undefined;
  return items.length ? [{ event_id: event?.event_id ?? crypto.randomUUID().replaceAll("-", ""), sent_at: new Date().toISOString() }, items] as Envelope : null;
}
export function privateTransport(dsn: string, fetchImpl: typeof fetch = fetch) {
  const endpoint = sentryEndpoint(dsn);
  if (!endpoint) throw new Error("Telemetry destination is unavailable.");
  return (options: TransportOptions): Transport => {
    const budget = createTelemetryBudgets();
    const transport = Sentry.createTransport({ ...options, bufferSize: 4 }, async ({ body }) => {
      // No incoming request headers, cookies, referrer or arbitrary destination.
      const response = await fetchImpl(endpoint, { method: "POST", body: body as BodyInit,
        headers: { "content-type": "application/x-sentry-envelope" }, credentials: "omit", referrerPolicy: "no-referrer",
        redirect: "error", signal: AbortSignal.timeout(3_000) });
      await response.body?.cancel();
      return { statusCode: response.status, headers: { "x-sentry-rate-limits": response.headers.get("x-sentry-rate-limits"), "retry-after": response.headers.get("retry-after") } };
    });
    return { send: (envelope) => {
      const clean = privateEnvelope(envelope, budget);
      return clean ? transport.send(clean) : Promise.resolve({ statusCode: 200 });
    }, flush: (timeout) => transport.flush(timeout) };
  };
}
