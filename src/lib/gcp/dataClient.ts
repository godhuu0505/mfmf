import "server-only";
import { createHmac } from "node:crypto";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";

/** The caller must obtain this identity by verifying an IdP token and revocation. */
export interface VerifiedIdentity {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  displayName?: string;
  picture?: string;
  authTime?: number;
  provider?: string;
}

const ORIGIN = "http://127.0.0.1:3001";
const AUDIENCE = "mfmf-internal-database";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type DatabaseRole = "anon" | "authenticated" | "identity_sync";
type ClientOptions = { secret?: string; fetchImpl?: typeof fetch; now?: () => number };

function signingKey(value: string | undefined): Buffer {
  if (!value || !/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    throw new Error("Internal database signing key is unavailable.");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== 32 || bytes.toString("base64") !== value) {
    throw new Error("Internal database signing key is invalid.");
  }
  return bytes;
}

function databaseToken(key: Buffer, role: DatabaseRole, userId: string | null, now: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const issued = Math.floor(now / 1000);
  const payload = Buffer.from(JSON.stringify({
    iss: "mfmf-server", aud: AUDIENCE, role,
    ...(userId ? { sub: userId } : {}), iat: issued, exp: issued + 60,
  })).toString("base64url");
  const message = `${header}.${payload}`;
  return `${message}.${createHmac("sha256", key).update(message).digest("base64url")}`;
}

function databaseClient(key: Buffer, role: DatabaseRole, userId: string | null, options: ClientOptions): SupabaseClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const internalFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    // This SDK is used only as a PostgREST query builder. Auth and Storage must
    // never silently reconnect to Supabase after the DB/Auth cutover.
    if (url.origin !== ORIGIN || !url.pathname.startsWith("/rest/v1/") || url.username || url.password || url.hash) {
      throw new Error("Unsupported internal database request.");
    }
    url.pathname = url.pathname.slice("/rest/v1".length);
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    headers.delete("apikey");
    headers.delete("cookie");
    headers.set("Authorization", `Bearer ${databaseToken(key, role, userId, now())}`);
    const timeout = AbortSignal.timeout(10_000);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    try {
      return await fetchImpl(url, { ...init, headers, signal, cache: "no-store", redirect: "error", credentials: "omit" });
    } catch {
      throw new Error("Internal database request failed; details withheld.");
    }
  };
  return createClient(ORIGIN, "internal-postgrest-only", {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { fetch: internalFetch },
  });
}

/** No public API accepts a role, DB user ID, endpoint or signing key from a browser. */
export async function createGcpDataClient(identity: VerifiedIdentity | null, options: ClientOptions = {}): Promise<{ client: SupabaseClient; user: User | null }> {
  const key = signingKey(options.secret ?? process.env.MFMF_DATABASE_JWT_SECRET);
  if (identity === null) return { client: databaseClient(key, "anon", null, options), user: null };
  if (!identity || typeof identity.subject !== "string" || identity.subject.length < 1 || identity.subject.length > 128 ||
      /[\u0000-\u001f\u007f]/.test(identity.subject) || typeof identity.emailVerified !== "boolean" ||
      (identity.email !== null && (typeof identity.email !== "string" || identity.email.length > 320 || /[\r\n\0]/.test(identity.email)))) {
    throw new Error("Verified identity is invalid; details withheld.");
  }
  const synchronizer = databaseClient(key, "identity_sync", null, options);
  const { data: userId, error } = await synchronizer.rpc("sync_identity", {
    p_subject: identity.subject,
    p_email: identity.emailVerified ? identity.email : null,
    p_email_verified: identity.emailVerified,
    // Admission comes only from server configuration, never from an IdP's
    // mutable isNewUser response or browser-provided metadata.
    p_allow_create: process.env.SIGNUP_ENABLED === "true",
  });
  if (error || typeof userId !== "string" || !UUID.test(userId)) {
    throw new Error("Identity database synchronization failed; details withheld.");
  }
  const provider = identity.provider === "google.com" || identity.provider === "google" ? "google" : "email";
  const user: User = {
    id: userId, aud: "authenticated", role: "authenticated", created_at: "",
    email: identity.emailVerified && identity.email ? identity.email : undefined,
    app_metadata: { provider, providers: [provider] },
    user_metadata: {
      ...(identity.displayName ? { full_name: identity.displayName, display_name: identity.displayName } : {}),
      ...(identity.picture ? { avatar_url: identity.picture } : {}),
    },
  };
  return { client: databaseClient(key, "authenticated", userId, options), user };
}
