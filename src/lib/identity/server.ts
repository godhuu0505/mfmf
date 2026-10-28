import "server-only";
import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { OAuth2Client } from "google-auth-library";
import { cookies } from "next/headers";
import { cache } from "react";
import { identityConfig } from "./config";
import { IdentityProtocol, type IdentityCookies } from "./protocol";

export function createIdentityProtocol(cookieStore: IdentityCookies): IdentityProtocol {
  const config = identityConfig();
  if (process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error("Identity emulator is not permitted in this server.");
  // A named app prevents accidental reuse of another project's Admin client.
  const app = getApps().find((candidate) => candidate.name === "mfmf-identity") ??
    initializeApp({ credential: applicationDefault(), projectId: config.projectId }, "mfmf-identity");
  if (app.options.projectId !== config.projectId) throw new Error("Identity project mismatch.");
  const auth = getAuth(app);
  return new IdentityProtocol(config, {
    fetch,
    verify: (token) => auth.verifyIdToken(token, true),
    verifyGoogle: async (token, audience) => {
      const ticket = await new OAuth2Client().verifyIdToken({ idToken: token, audience });
      const payload = ticket.getPayload();
      return { sub: payload?.sub, nonce: (payload as { nonce?: string } | undefined)?.nonce };
    },
    revoke: (subject) => auth.revokeRefreshTokens(subject),
    recordConsent: (subject, at) => auth.setCustomUserClaims(subject, { tos_accepted_at: at }),
    admit: async (identity) => {
      const { createGcpDataClient } = await import("@/lib/gcp/dataClient");
      const { user } = await createGcpDataClient(identity);
      if (!user) throw new Error("Identity admission denied.");
    },
  }, cookieStore);
}

export async function getIdentityProtocol() {
  const store = await cookies();
  return createIdentityProtocol({ get: (name) => store.get(name)?.value,
    set: (name, value, options) => {
      try { store.set(name, value, options); }
      catch { /* RSC cannot write cookies; middleware refreshes the request first. */ }
    } });
}

/** Only verified, non-revoked identities cross into the internal database bridge. */
export const getVerifiedIdentity = cache(async () => (await getIdentityProtocol()).verifiedIdentity());
