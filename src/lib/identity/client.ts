"use client";

import { createClient } from "@/lib/supabase/client";

type Result = { error: { message: string } | null; data: { session: object | null } };
type Credentials = { email: string; password: string };
const FAILURE = "Authentication unavailable";

async function mutation(operation: string, input: Record<string, unknown> = {}): Promise<Result & { url?: string }> {
  try {
    const csrfResponse = await fetch("/auth/identity/session", { credentials: "same-origin", cache: "no-store", redirect: "error" });
    const csrf = await csrfResponse.json();
    if (!csrfResponse.ok || typeof csrf.csrfToken !== "string") throw new Error();
    const response = await fetch("/auth/identity/session", { method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
      headers: { "content-type": "application/json", "x-mfmf-csrf": csrf.csrfToken }, body: JSON.stringify({ operation, ...input }) });
    const data = await response.json();
    if (!response.ok) {
      const message = data.error === "unverified" ? "Email not confirmed" : data.error === "invalid" ? "Invalid login credentials" : FAILURE;
      return { data: { session: null }, error: { message } };
    }
    return { data: { session: data.signedIn === true ? {} : null }, error: null, ...(typeof data.url === "string" ? { url: data.url } : {}) };
  } catch { return { data: { session: null }, error: { message: FAILURE } }; }
}

/** Authentication only. No IdP token, API key, database JWT or refresh token enters browser JS. */
export function createAuthClient() {
  if (process.env.NEXT_PUBLIC_GCP_AUTH_ENABLED !== "true") return createClient();
  return { auth: {
    signInWithPassword: (input: Credentials) => mutation("password", input),
    signUp: (input: Credentials & { options?: { emailRedirectTo?: string; data?: { tos_accepted_at?: string } } }) =>
      mutation("signup", { email: input.email, password: input.password, acceptedTerms: typeof input.options?.data?.tos_accepted_at === "string" }),
    resetPasswordForEmail: (email: string, _options?: { redirectTo?: string }) => mutation("forgot", { email }),
    updateUser: (input: { password?: string }) => mutation("update-password", { password: input.password }),
    signInWithOAuth: async (_input: { provider: "google"; options?: { redirectTo?: string; scopes?: string; queryParams?: Record<string, string> } }) => {
      const result = await mutation("google");
      if (!result.error) {
        try {
          const target = new URL(result.url ?? "");
          if (target.origin !== "https://accounts.google.com" || target.username || target.password || target.hash) throw new Error();
          window.location.assign(target.href);
        } catch { return { error: { message: FAILURE }, data: { session: null } }; }
      }
      return result;
    },
  } };
}
