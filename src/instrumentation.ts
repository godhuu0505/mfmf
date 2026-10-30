import * as Sentry from "@sentry/nextjs";
import { errorType, privateErrorEvent, privateMetric, sentryEndpoint, telemetryRoute } from "@/lib/telemetry/privacy";
import { privateTransport } from "@/lib/telemetry/transport";
import { flushTelemetry } from "@/lib/telemetry/flush";

export async function register() {
  const dsn = process.env.SENTRY_DSN;
  if (!sentryEndpoint(dsn) || !["nodejs", "edge"].includes(process.env.NEXT_RUNTIME ?? "")) return;
  Sentry.init({
    dsn, environment: "production", defaultIntegrations: false,
    // No automatic HTTP/DB instrumentation, logs, replay, sessions or profiling.
    skipOpenTelemetrySetup: true, enableLogs: false, enableMetrics: true,
    sendDefaultPii: false, sendClientReports: false, maxBreadcrumbs: 0, debug: false,
    beforeSend: (event) => privateErrorEvent(event),
    beforeSendTransaction: () => null, beforeSendLog: () => null,
    beforeSendMetric: privateMetric, beforeBreadcrumb: () => null,
    transport: privateTransport(dsn!),
  });
}

// Do not pass Next's request/headers/error object to the SDK. Even the exception
// message and stack can contain record text, credentials or signed image URLs.
export const onRequestError: typeof Sentry.captureRequestError = async (error, _request, context) => {
  if (!sentryEndpoint(process.env.SENTRY_DSN)) return;
  try {
    Sentry.captureEvent({ exception: { values: [{ type: errorType(error) }] },
      tags: { category: "server", route: telemetryRoute(context.routePath) } });
    await flushTelemetry();
  } catch { /* Telemetry cannot replace the original application failure. */ }
};
