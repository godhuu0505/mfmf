import "server-only";

export function isGcpAuthEnabled(): boolean {
  if (![undefined, "false", "true"].includes(process.env.GCP_AUTH_ENABLED) ||
      ![undefined, "false", "true"].includes(process.env.NEXT_PUBLIC_GCP_AUTH_ENABLED)) {
    throw new Error("Identity mode configuration is invalid.");
  }
  if ((process.env.GCP_AUTH_ENABLED === "true") !== (process.env.NEXT_PUBLIC_GCP_AUTH_ENABLED === "true")) {
    throw new Error("Identity mode configuration mismatch.");
  }
  return process.env.GCP_AUTH_ENABLED === "true";
}

export interface IdentityConfig {
  projectId: string;
  apiKey: string;
  origin: string;
  googleClientId: string;
  secure: boolean;
  signupEnabled: boolean;
}

export function identityConfig(): IdentityConfig {
  const projectId = process.env.GCP_PROJECT_ID;
  const apiKey = process.env.IDENTITY_PLATFORM_API_KEY;
  const googleClientId = process.env.GOOGLE_CLIENT_ID;
  const rawOrigin = process.env.GCP_AUTH_ORIGIN;
  if (!isGcpAuthEnabled() || process.env.NEXT_PUBLIC_GCP_AUTH_ENABLED !== "true" ||
      !projectId || !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(projectId) ||
      !apiKey || !/^[A-Za-z0-9_-]{20,128}$/.test(apiKey) ||
      !googleClientId || !/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(googleClientId) || !rawOrigin) {
    throw new Error("Identity configuration is unavailable; details withheld.");
  }
  let origin: URL;
  try { origin = new URL(rawOrigin); } catch { throw new Error("Identity origin is invalid."); }
  const local = process.env.NODE_ENV !== "production" &&
    origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname);
  if ((!local && origin.protocol !== "https:") || rawOrigin !== origin.origin || origin.username || origin.password) {
    throw new Error("Identity origin is invalid.");
  }
  return { projectId, apiKey, origin: origin.origin, googleClientId,
    secure: !local, signupEnabled: process.env.SIGNUP_ENABLED === "true" };
}
