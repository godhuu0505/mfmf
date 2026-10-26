import { pathToFileURL } from "node:url";

// 診断はこの固定名と enum / boolean / 型だけ。応答の value / ID / 任意文字列は出さない。
const KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "TOKEN_ENC_KEY",
  "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "SENTRY_DSN", "SIGNUP_ENABLED",
  "SENTRY_ENVIRONMENT", "SENTRY_TRACES_SAMPLE_RATE",
];
class InspectionError extends Error {}
const known = (value, choices) => choices.includes(value) ? value : "unknown";
const valueType = (value) => value === null ? "null" : Array.isArray(value) ? "array" : typeof value;

export function environmentMetadata(response) {
  if (!Array.isArray(response?.envs) || response.envs.length > 10_000) {
    throw new InspectionError("Vercel returned an invalid environment list; body withheld.");
  }
  return {
    hasNextPage: response.pagination?.next != null,
    hiddenProductionEntries: typeof response.hiddenProductionEnvCount === "number"
      ? response.hiddenProductionEnvCount > 0 : "unknown",
    settings: KEYS.map((key) => ({
      key,
      entries: response.envs.filter((item) => item?.key === key).map((item) => {
        const targets = Array.isArray(item.target) ? item.target : [item.target];
        return {
          production: targets.includes("production"),
          scopeKnown: Array.isArray(item.target) || typeof item.target === "string",
          branchSpecific: Boolean(item.gitBranch),
          type: known(item.type, ["plain", "encrypted", "secret", "sensitive", "system"]),
          visibility: item.visibility === undefined ? "absent" : known(item.visibility, ["config", "secret"]),
          decryptedPresent: Object.hasOwn(item, "decrypted"),
          decryptedType: valueType(item.decrypted),
          decrypted: typeof item.decrypted === "boolean" ? item.decrypted : null,
          valuePresent: Object.hasOwn(item, "value"),
          valueType: valueType(item.value),
          legacySecretMigration: typeof item.sunsetSecretId === "string" && item.sunsetSecretId.length > 0,
        };
      }),
    })),
  };
}

export async function inspectEnvironment({ env, fetchImpl = fetch }) {
  if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_REF !== "refs/heads/main" || env.GITHUB_EVENT_NAME !== "workflow_dispatch") {
    throw new InspectionError("Environment inspection requires a manual main workflow run.");
  }
  if (![env.VERCEL_TOKEN, env.VERCEL_ORG_ID, env.VERCEL_PROJECT_ID].every((value) => typeof value === "string" && value.length > 0)) {
    throw new InspectionError("Required Vercel credentials are missing.");
  }
  const url = new URL(`https://api.vercel.com/v10/projects/${encodeURIComponent(env.VERCEL_PROJECT_ID)}/env`);
  url.searchParams.set("teamId", env.VERCEL_ORG_ID);
  let response;
  try {
    response = await fetchImpl(url.href, {
      method: "GET",
      headers: { Authorization: `Bearer ${env.VERCEL_TOKEN}` },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new InspectionError("Vercel request failed (network or timeout); details withheld.");
  }
  if (!response.ok) throw new InspectionError(`Vercel request failed (HTTP ${response.status}); body withheld.`);
  let data;
  try { data = await response.json(); } catch { throw new InspectionError("Vercel returned invalid JSON; body withheld."); }
  return environmentMetadata(data);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  inspectEnvironment({ env: process.env }).then(
    (metadata) => console.log(JSON.stringify(metadata, null, 2)),
    (error) => {
      console.error(error instanceof InspectionError ? error.message : "Environment inspection failed; details withheld.");
      process.exitCode = 1;
    },
  );
}
