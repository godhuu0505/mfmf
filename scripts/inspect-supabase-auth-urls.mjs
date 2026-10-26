import { pathToFileURL } from "node:url";

// GET /v1/projects/{ref}/config/auth: site_url / uri_allow_list are required nullable strings.
// https://api.supabase.com/api/v1-json
// The full response can contain SMTP / provider secrets. Never log or persist it.
const MAX_BODY_BYTES = 262_144;
const KNOWN_PATHS = new Set(["/", "/auth/callback", "/reset-password", "/*", "/**", "/auth/*", "/auth/**"]);
class InspectionError extends Error {}

function summarizeUrl(raw, allowPattern = false) {
  if (raw === null || raw.trim() === "") return { kind: "not-configured" };
  // Backslashes/control characters can change URL parsing; withhold ambiguous input entirely.
  if (raw.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(raw)) return { kind: "unsupported-url-withheld" };
  let url;
  try { url = new URL(raw); } catch { return { kind: "unsupported-url-withheld" }; }
  if (!["http:", "https:"].includes(url.protocol)) return { kind: "unsupported-scheme-withheld" };
  if (url.username || url.password) return { kind: "credentials-withheld" };
  return {
    kind: allowPattern && /[*?\[\]{}]/.test(raw) ? "pattern-unverified" : "url-unverified",
    origin: url.origin,
    // Only auth paths and common wildcard paths are needed; arbitrary paths may contain tokens.
    pathname: KNOWN_PATHS.has(url.pathname) ? url.pathname : "[other-path-withheld]",
    hasQuery: Boolean(url.search),
    hasFragment: Boolean(url.hash),
  };
}

export function summarizeAuthUrls(config) {
  if (!config || typeof config !== "object" || Array.isArray(config) ||
      !["site_url", "uri_allow_list"].every((key) => config[key] === null || typeof config[key] === "string")) {
    throw new InspectionError("Supabase auth URL settings have an unexpected schema; body withheld.");
  }
  const list = config.uri_allow_list;
  if (list !== null && list.length > 32_768) throw new InspectionError("Supabase redirect list is too large; body withheld.");
  const entries = list?.trim() ? list.split(",").map((entry) => entry.trim()) : [];
  if (entries.length > 200) throw new InspectionError("Supabase redirect list is too large; body withheld.");
  return {
    operation: "GET-only",
    matching: "not-evaluated",
    site_url: summarizeUrl(config.site_url),
    uri_allow_list: entries.map((entry) => summarizeUrl(entry, true)),
  };
}

async function readConfig(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new InspectionError("Supabase returned an empty body; details withheld.");
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw new InspectionError("Supabase auth response is too large; body withheld.");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof InspectionError) throw error;
    throw new InspectionError("Supabase auth response could not be read as JSON; body withheld.");
  } finally { reader.releaseLock(); }
}

export async function inspectAuthUrls({ env, fetchImpl = fetch }) {
  if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_REF !== "refs/heads/main" || env.GITHUB_EVENT_NAME !== "workflow_dispatch") {
    throw new InspectionError("Auth URL inspection requires a manual main workflow run.");
  }
  const token = env.SUPABASE_ACCESS_TOKEN;
  const ref = env.SUPABASE_PROJECT_ID;
  if (typeof token !== "string" || !token || /[\r\n]/.test(token) || typeof ref !== "string" || !/^[a-z]{20}$/.test(ref)) {
    throw new InspectionError("Required Supabase credentials are missing or invalid.");
  }
  let response;
  try {
    response = await fetchImpl(`https://api.supabase.com/v1/projects/${ref}/config/auth`, {
      method: "GET", headers: { Authorization: `Bearer ${token}` },
      redirect: "error", signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new InspectionError("Supabase request failed (network or timeout); details withheld.");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new InspectionError(`Supabase auth inspection failed (HTTP ${response.status}); body withheld.`);
  }
  return summarizeAuthUrls(await readConfig(response));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  inspectAuthUrls({ env: process.env }).then(
    (summary) => console.log(JSON.stringify(summary, null, 2)),
    (error) => {
      console.error(error instanceof InspectionError ? error.message : "Auth URL inspection failed; details withheld.");
      process.exitCode = 1;
    },
  );
}
