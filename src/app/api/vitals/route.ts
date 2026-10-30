import * as Sentry from "@sentry/nextjs";
import { isSameOriginPost } from "@/lib/sameOriginPost";
import { createBudget } from "@/lib/telemetry/limits";
import { parseBrowserTelemetry, sentryEndpoint } from "@/lib/telemetry/privacy";
import { flushTelemetry } from "@/lib/telemetry/flush";

// Existing middleware verifies the session and drops anonymous GET/POST with 204.
// No public DSN or secret is returned. A browser caches this decision per document.
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const accept = createBudget(60, 60_000);
export function GET() { return Response.json({ enabled: Boolean(sentryEndpoint(process.env.SENTRY_DSN)) }, { headers }); }
export async function POST(request: Request) {
  const finish = (status = 204) => new Response(null, { status, headers });
  if (!sentryEndpoint(process.env.SENTRY_DSN)) return finish();
  if (!isSameOriginPost(request)) return finish(403);
  if (request.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/json") return finish(415);
  if (!accept()) return finish(429);
  const reader = request.body?.getReader();
  if (!reader) return finish(400);
  let size = 0; const chunks: Uint8Array[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Telemetry input timeout.")), 2_000); });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      size += value.byteLength;
      if (size > 1024) { void reader.cancel().catch(() => undefined); return finish(413); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const payload = parseBrowserTelemetry(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    if (!payload) return finish(400);
    if (payload.kind === "error") Sentry.captureEvent({ tags: { category: payload.category, route: payload.route }, exception: { values: [{ type: "Error" }] } });
    else Sentry.metrics.distribution(`web_vital.${payload.name.toLowerCase()}`, payload.value, {
      unit: payload.name === "CLS" ? "none" : "millisecond",
      attributes: { route: payload.route, rating: payload.rating, navigation_type: payload.navigationType },
    });
    // One bounded flush for an accepted, sampled payload; failure never affects UI.
    await flushTelemetry();
    return finish();
  } catch { void reader.cancel().catch(() => undefined); return finish(400); }
  finally { clearTimeout(timer); }
}
