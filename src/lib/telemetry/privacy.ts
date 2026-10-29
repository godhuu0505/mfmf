/** Only these route labels cross the telemetry boundary. Never return input. */
const ROUTES = new Set(["/", "/login", "/signup", "/forgot-password", "/reset-password", "/records/new", "/calendar", "/gallery", "/pets", "/weight", "/settings", "/feedback", "/offline", "/help", "/menu", "/onboarding", "/guest", "/guest/records/new", "/terms", "/privacy"]);
export function telemetryRoute(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 2048) return "other";
  const path = raw.split(/[?#]/, 1)[0];
  if (ROUTES.has(path)) return path;
  if (/^\/records\/[^/]+$/.test(path)) return "/records/[id]";
  if (/^\/pets\/[^/]+$/.test(path)) return "/pets/[id]";
  if (/^\/invite\/[^/]+$/.test(path)) return "/invite/[token]";
  if (/^\/share\/[^/]+$/.test(path)) return "/share/[token]";
  if (path.startsWith("/auth/")) return "/auth/*";
  if (path.startsWith("/api/")) return "/api/*";
  return "other";
}
export const ERROR_KINDS = ["render", "global-render", "unhandled-error", "unhandled-rejection", "server"] as const;
export type ErrorKind = typeof ERROR_KINDS[number];
const TYPES = new Set(["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError", "AggregateError"]);
export function errorType(error: unknown): string {
  try { return error instanceof Error && TYPES.has(error.name) ? error.name : "Error"; }
  catch { return "Error"; }
}
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
export const VITALS = ["CLS", "FCP", "INP", "LCP", "TTFB"] as const;
const RATINGS = new Set(["good", "needs-improvement", "poor"]);
const NAVIGATIONS = new Set(["navigate", "reload", "back-forward", "back-forward-cache", "prerender", "restore"]);
export type Vital = { kind: "vital"; name: typeof VITALS[number]; value: number; rating: string; navigationType: string; route: string };
export type BrowserError = { kind: "error"; category: Exclude<ErrorKind, "server">; route: string };
export function parseBrowserTelemetry(input: unknown): Vital | BrowserError | null {
  const row = object(input);
  if (!row) return null;
  const route = telemetryRoute(row.route);
  if (row.kind === "error" && ERROR_KINDS.includes(row.category as ErrorKind) && row.category !== "server" &&
      Object.keys(row).every((key) => ["kind", "category", "route"].includes(key))) {
    return { kind: "error", category: row.category as BrowserError["category"], route };
  }
  if (row.kind !== "vital" || Object.keys(row).some((key) => !["kind", "name", "value", "rating", "navigationType", "route"].includes(key)) ||
      !VITALS.includes(row.name as Vital["name"]) || typeof row.value !== "number" || !Number.isFinite(row.value) ||
      row.value < 0 || row.value > (row.name === "CLS" ? 10 : 120_000)) return null;
  return { kind: "vital", name: row.name as Vital["name"], value: Math.round(row.value * 1000) / 1000,
    rating: RATINGS.has(row.rating as string) ? row.rating as string : "unknown",
    navigationType: NAVIGATIONS.has(row.navigationType as string) ? row.navigationType as string : "unknown", route };
}
/** No raw message, stack, URL, headers, cookies, user, breadcrumbs, scope or extra. */
export function privateErrorEvent(input: unknown) {
  const event = object(input);
  if (!event || event.type !== undefined) return null;
  const tags = object(event.tags);
  const category = ERROR_KINDS.includes(tags?.category as ErrorKind) ? tags!.category as ErrorKind : "server";
  const route = telemetryRoute(tags?.route);
  const exceptions = object(event.exception)?.values;
  const type = Array.isArray(exceptions) && TYPES.has(object(exceptions[0])?.type as string) ? object(exceptions[0])!.type as string : "Error";
  return {
    ...(typeof event.event_id === "string" && /^[a-f0-9]{32}$/.test(event.event_id) ? { event_id: event.event_id } : {}),
    type: undefined, level: "error" as const, platform: "javascript", environment: "production",
    exception: { values: [{ type, value: `mfmf ${category} failure; details withheld` }] },
    fingerprint: ["mfmf-private-v1", category, route, type], tags: { category, route },
  };
}
export function privateMetric(input: unknown) {
  const metric = object(input);
  if (!metric || metric.type !== "distribution" || typeof metric.name !== "string") return null;
  const name = VITALS.find((value) => `web_vital.${value.toLowerCase()}` === metric.name);
  if (!name) return null;
  const attributes = object(metric.attributes) ?? {};
  const vital = parseBrowserTelemetry({ kind: "vital", name, value: metric.value, route: attributes.route,
    rating: attributes.rating, navigationType: attributes.navigation_type });
  if (!vital || vital.kind !== "vital") return null;
  return { name: metric.name, type: "distribution" as const, value: vital.value, unit: name === "CLS" ? "none" : "millisecond",
    attributes: { route: vital.route, rating: vital.rating, navigation_type: vital.navigationType } };
}
/** Sentry SaaS only. No credentials are returned to a browser or written to logs. */
export function sentryEndpoint(dsn: unknown): string | null {
  if (typeof dsn !== "string" || !/^https:\/\/[a-f0-9]{32}@o\d+\.ingest(?:\.(?:us|de))?\.sentry\.io\/\d+$/.test(dsn)) return null;
  const url = new URL(dsn);
  return `${url.origin}/api${url.pathname}/envelope/?sentry_version=7&sentry_key=${url.username}`;
}
