import { pathToFileURL } from "node:url";

// Only these two candidate callbacks may be appended. No URL or project override input.
export const CALLBACK_URLS = Object.freeze([
  "https://mfmf-candidate-wspqvmhj6q-an.a.run.app/auth/callback",
  "https://mfmf-candidate-wspqvmhj6q-an.a.run.app/auth/callback?next=/reset-password",
]);
const MAX_BODY_BYTES = 262_144;
const MAX_LIST_BYTES = 32_768;
class UpdateError extends Error {}

function selectConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config) ||
      !["site_url", "uri_allow_list"].every((key) => config[key] === null || typeof config[key] === "string")) {
    throw new UpdateError("Auth URL settings have an unexpected schema; body withheld.");
  }
  const list = config.uri_allow_list;
  if (list !== null && (Buffer.byteLength(list) > MAX_LIST_BYTES || list.split(",").length > 200)) {
    throw new UpdateError("Auth redirect list exceeds safety limits; body withheld.");
  }
  // Discard provider / SMTP fields immediately; retain only the two fields needed for comparison.
  return { site_url: config.site_url, uri_allow_list: list };
}

async function readConfig(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new UpdateError("Auth config response is empty; body withheld.");
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw new UpdateError("Auth config response exceeds safety limits; body withheld.");
      }
      chunks.push(value);
    }
    return selectConfig(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch (error) {
    if (error instanceof UpdateError) throw error;
    throw new UpdateError("Auth config response could not be read; details withheld.");
  } finally { reader.releaseLock(); }
}

export async function addCloudRunAuthUrls({ env, fetchImpl = fetch }) {
  if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_REF !== "refs/heads/main" || env.GITHUB_EVENT_NAME !== "workflow_dispatch") {
    throw new UpdateError("Auth URL preparation requires a manual main workflow run.");
  }
  const apply = env.SUPABASE_AUTH_URLS_APPLY ?? "false";
  if (apply !== "true" && apply !== "false") throw new UpdateError("Apply must be an explicit boolean.");
  const token = env.SUPABASE_ACCESS_TOKEN;
  const ref = env.SUPABASE_PROJECT_ID;
  if (typeof token !== "string" || !token || /[\r\n]/.test(token) || typeof ref !== "string" || !/^[a-z]{20}$/.test(ref)) {
    throw new UpdateError("Required Supabase credentials are missing or invalid.");
  }
  const endpoint = `https://api.supabase.com/v1/projects/${ref}/config/auth`;
  async function request(method, body) {
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error", signal: AbortSignal.timeout(15_000),
      });
    } catch { throw new UpdateError("Supabase request failed (network or timeout); details withheld."); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new UpdateError(`Supabase request failed (HTTP ${response.status}); body withheld.`);
    }
    return response;
  }
  const initial = await readConfig(await request("GET"));
  const entries = new Set(initial.uri_allow_list?.split(",").map((entry) => entry.trim()) ?? []);
  const missing = CALLBACK_URLS.filter((url) => !entries.has(url));
  const mode = apply === "true" ? "apply" : "plan";
  if (!missing.length) return { mode, status: "unchanged", added: 0 };
  // Keep the original string byte-for-byte, including whitespace, order, and duplicate entries.
  const prefix = initial.uri_allow_list ?? "";
  const updatedList = `${prefix}${prefix ? "," : ""}${missing.join(",")}`;
  selectConfig({ site_url: initial.site_url, uri_allow_list: updatedList });
  if (apply !== "true") return { mode, status: "planned", additions: missing };

  const beforeWrite = await readConfig(await request("GET"));
  if (beforeWrite.site_url !== initial.site_url || beforeWrite.uri_allow_list !== initial.uri_allow_list) {
    throw new UpdateError("Auth URL settings changed before update; no PATCH sent. Run plan again.");
  }
  // The Management API does not document CAS / If-Match. This check narrows, but cannot remove, the race.
  // Once PATCH is attempted its outcome may be unknown on failure. Never retry or roll back automatically.
  try {
    const response = await request("PATCH", { uri_allow_list: updatedList });
    await response.body?.cancel().catch(() => {});
    const verified = await readConfig(await request("GET"));
    if (verified.site_url !== initial.site_url || verified.uri_allow_list !== updatedList) {
      throw new UpdateError("Auth URL verification mismatch.");
    }
  } catch {
    throw new UpdateError("PATCH was attempted but final settings could not be verified; no retry or rollback. Inspect settings before any further update.");
  }
  return { mode, status: "applied", added: missing.length, siteUrlUnchanged: true, existingAllowlistPreserved: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const run = async () => {
    if (process.argv.length !== 2) throw new UpdateError("Command-line arguments are not supported.");
    return addCloudRunAuthUrls({ env: process.env });
  };
  run().then(
    (summary) => console.log(JSON.stringify(summary, null, 2)),
    (error) => {
      console.error(error instanceof UpdateError ? error.message : "Auth URL preparation failed; details withheld.");
      process.exitCode = 1;
    },
  );
}
