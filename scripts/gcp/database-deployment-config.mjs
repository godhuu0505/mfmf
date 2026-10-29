import { PROJECT, PROJECT_NUMBER, PUBLIC_ORIGIN, SERVICE_NAME } from "./production-config.mjs";

export const DATABASE_SECRETS = Object.freeze({
  MFMF_DATABASE_PASSWORD: "mfmf-database-password",
  IDENTITY_PLATFORM_API_KEY: "mfmf-identity-platform-api-key",
});
export const DATABASE_ENV_KEYS = ["GCP_AUTH_ENABLED", "NEXT_PUBLIC_GCP_AUTH_ENABLED", "GCP_PROJECT_ID", "GCP_AUTH_ORIGIN"];
export const DATABASE_VPC = Object.freeze({ egress: "PRIVATE_RANGES_ONLY", networkInterfaces: [
  { network: "mfmf-db-network", subnetwork: "mfmf-app-tokyo" },
] });
const fail = () => { throw new Error("Database deployment configuration differs; values withheld."); };
export function databaseMode(env) {
  const value = env.GCP_AUTH_ENABLED ?? "false";
  if (!["false", "true"].includes(value)) fail();
  if (env.NEXT_PUBLIC_GCP_AUTH_ENABLED !== undefined && env.NEXT_PUBLIC_GCP_AUTH_ENABLED !== value) fail();
  return value === "true";
}
export function databasePins(text) {
  let refs;
  try { refs = JSON.parse(text); } catch { fail(); }
  if (!refs || typeof refs !== "object" || Array.isArray(refs) || Object.keys(refs).length !== 2) fail();
  for (const [key, name] of Object.entries(DATABASE_SECRETS)) {
    if (typeof refs[key] !== "string" || !new RegExp(`^projects/${PROJECT_NUMBER}/secrets/${name}/versions/[1-9][0-9]*$`).test(refs[key])) fail();
  }
  return refs;
}
export function databasePublicEnv(config) {
  return { ...config, NEXT_PUBLIC_SUPABASE_URL: "https://placeholder.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "disabled-supabase-client", GCP_AUTH_ENABLED: "true",
    NEXT_PUBLIC_GCP_AUTH_ENABLED: "true", GCP_PROJECT_ID: PROJECT, GCP_AUTH_ORIGIN: PUBLIC_ORIGIN };
}
export function isDatabaseVpc(value) {
  if (!value || value.connector || value.egress !== "PRIVATE_RANGES_ONLY"
    || Object.keys(value).some((key) => !["egress", "networkInterfaces"].includes(key))
    || !Array.isArray(value.networkInterfaces) || value.networkInterfaces.length !== 1) return false;
  const item = value.networkInterfaces[0];
  const network = `projects/${PROJECT}/global/networks/mfmf-db-network`;
  const subnet = `projects/${PROJECT}/regions/asia-northeast1/subnetworks/mfmf-app-tokyo`;
  return item && Object.keys(item).every((key) => ["network", "subnetwork", "tags"].includes(key))
    && ["mfmf-db-network", network].includes(item.network)
    && ["mfmf-app-tokyo", subnet].includes(item.subnetwork)
    && (item.tags === undefined || (Array.isArray(item.tags) && item.tags.length === 0));
}

// Reuse preferences and an optional existing Sentry reference, or an explicitly
// committed fixed Sentry version for its first rollout. No secret value is read.
export function databaseSourceConfig(service, pins) {
  if (service?.name !== SERVICE_NAME || service.uri !== PUBLIC_ORIGIN || service.template?.containers?.length !== 1) fail();
  const entries = service.template.containers[0].env;
  if (!Array.isArray(entries)) fail();
  const seen = new Set();
  const values = {};
  let sentryRef;
  for (const item of entries) {
    if (!item || typeof item.name !== "string" || seen.has(item.name)) fail();
    seen.add(item.name);
    if (["SIGNUP_ENABLED", "SENTRY_ENVIRONMENT", "SENTRY_TRACES_SAMPLE_RATE"].includes(item.name)) {
      if (Object.keys(item).length !== 2 || typeof item.value !== "string") fail();
      values[item.name] = item.value;
    }
    if (item.name === "SENTRY_DSN") {
      const ref = item.valueSource?.secretKeyRef;
      if (Object.hasOwn(item, "value") || !ref || !["mfmf-sentry-dsn",
        `projects/${PROJECT}/secrets/mfmf-sentry-dsn`, `projects/${PROJECT_NUMBER}/secrets/mfmf-sentry-dsn`].includes(ref.secret)
        || !/^[1-9][0-9]*$/.test(ref.version ?? "")) fail();
      sentryRef = `projects/${PROJECT_NUMBER}/secrets/mfmf-sentry-dsn/versions/${ref.version}`;
    }
  }
  const sentryPin = pins?.SENTRY_DSN;
  if (sentryPin !== undefined) {
    if (typeof sentryPin !== "string" || !new RegExp(`^projects/${PROJECT_NUMBER}/secrets/mfmf-sentry-dsn/versions/[1-9][0-9]*$`).test(sentryPin)
      || (sentryRef && sentryRef !== sentryPin)) fail();
    sentryRef = sentryPin;
  }
  values.SIGNUP_ENABLED ??= "false";
  values.SENTRY_ENVIRONMENT ??= "cloud-run-candidate";
  values.SENTRY_TRACES_SAMPLE_RATE ??= "0.1";
  if (!["true", "false"].includes(values.SIGNUP_ENABLED) || !/^[A-Za-z0-9._-]{1,64}$/.test(values.SENTRY_ENVIRONMENT)
    || !/^(0(\.\d+)?|1(\.0+)?)$/.test(values.SENTRY_TRACES_SAMPLE_RATE)) fail();
  return { publicEnv: databasePublicEnv(values), secrets: {},
    secretVersions: { ...pins, ...(sentryRef ? { SENTRY_DSN: sentryRef } : {}) },
    features: { googleDriveConfigured: true, sentryConfigured: Boolean(sentryRef) } };
}
