import { parseBrowserTelemetry, telemetryRoute, type BrowserError } from "./privacy";

export function createBrowserReporter({ fetchImpl = fetch, random = Math.random, path = () => typeof window === "undefined" ? "other" : window.location.pathname } = {}) {
  let configuration: Promise<boolean> | undefined;
  let errors = 0;
  const reported = new Set<string>();
  const sampled = random() < 0.1;
  const enabled = () => configuration ??= fetchImpl("/api/vitals", { credentials: "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(2_000) })
    .then(async (response) => response.status === 200 && (await response.json())?.enabled === true).catch(() => false);
  const send = async (input: unknown) => {
    const payload = parseBrowserTelemetry(input);
    if (!payload || process.env.NODE_ENV !== "production") return;
    const key = `${payload.kind}:${payload.kind === "vital" ? payload.name : payload.category}`;
    if (reported.has(key) || (payload.kind === "vital" && !sampled) || (payload.kind === "error" && errors >= 3)) return;
    reported.add(key);
    if (payload.kind === "error") errors++;
    if (!await enabled()) return;
    await fetchImpl("/api/vitals", { method: "POST", body: JSON.stringify(payload), headers: { "content-type": "application/json" },
      credentials: "same-origin", cache: "no-store", keepalive: true, redirect: "error", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(2_000) }).catch(() => undefined);
  };
  return {
    error: (category: BrowserError["category"]) => send({ kind: "error", category, route: telemetryRoute(path()) }),
    vital: (metric: { name: string; value: number; rating?: string; navigationType?: string }) => send({ kind: "vital", name: metric.name,
      value: metric.value, rating: metric.rating, navigationType: metric.navigationType, route: telemetryRoute(path()) }),
  };
}
let reporter: ReturnType<typeof createBrowserReporter> | undefined;
export function browserReporter() { return reporter ??= createBrowserReporter(); }
