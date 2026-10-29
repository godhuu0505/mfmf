import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DecodedIdToken } from "firebase-admin/auth";
import { IdentityError, IdentityProtocol, identityFromToken, type CookieOptions } from "@/lib/identity/protocol";
import { identityConfig, isGcpAuthEnabled } from "@/lib/identity/config";

const config = { projectId: "mfmf-fixture", apiKey: "fixture-public-api-key-only", origin: "https://app.example", googleClientId: "fixture.apps.googleusercontent.com", secure: true, signupEnabled: true };
const NOW = 1_800_000_000_000;
const NONCE = "n".repeat(43);
const STATE = "provider-generated-state";
const TOKEN = `header.${Buffer.from(JSON.stringify({ sub: "user-one" })).toString("base64url")}.signature`;
const SECRET = "private-provider-response-marker";
function decoded(overrides: Partial<DecodedIdToken> = {}): DecodedIdToken {
  return { uid: "user-one", sub: "user-one", email: "fixture@example.com", email_verified: true, auth_time: NOW / 1000,
    aud: config.projectId, iss: `https://securetoken.google.com/${config.projectId}`, iat: NOW / 1000, exp: NOW / 1000 + 3600,
    firebase: { identities: { "google.com": ["google-subject"] }, sign_in_provider: "google.com" }, ...overrides };
}
function fixture() {
  const values = new Map<string, string>(); const writes: { name: string; value: string; options: CookieOptions }[] = [];
  const queue: { status?: number; data: unknown }[] = [];
  const fetchMock = vi.fn(async () => { const item = queue.shift(); if (!item) throw new Error(`unexpected ${SECRET}`);
    return new Response(JSON.stringify(item.data), { status: item.status ?? 200 }); });
  const verify = vi.fn(async (_token: string) => decoded());
  const verifyGoogle = vi.fn(async () => ({ sub: "google-subject", nonce: NONCE }));
  const revoke = vi.fn(async () => {}); const consent = vi.fn(async () => {}); const admit = vi.fn(async () => {});
  const protocol = new IdentityProtocol(config, { fetch: fetchMock as typeof fetch, verify, verifyGoogle, revoke,
    recordConsent: consent, admit, now: () => NOW, random: () => NONCE }, {
    get: (name) => values.get(name), set: (name, value, options) => { values.set(name, value); writes.push({ name, value, options }); },
  });
  const set = (kind: string, value: string) => values.set(protocol.name(kind), value);
  const get = (kind: string) => values.get(protocol.name(kind));
  const accept = () => queue.push({ data: { idToken: TOKEN, refreshToken: "opaque-refresh-token" } });
  const google = (uri?: string) => queue.push({ data: { providerId: "google.com", sessionId: "provider-session", authUri: uri ??
    `https://accounts.google.com/o/oauth2/v2/auth?client_id=${config.googleClientId}&redirect_uri=${encodeURIComponent(`${config.origin}/auth/callback`)}&state=${STATE}&nonce=${NONCE}&response_type=code` } });
  const complete = (extra = {}) => queue.push({ data: { providerId: "google.com", idToken: TOKEN, refreshToken: "opaque-refresh-token", oauthIdToken: "google-token", oauthRefreshToken: "drive-refresh-token", ...extra } });
  const body = (index: number) => JSON.parse(String((fetchMock.mock.calls[index] as unknown as [URL, RequestInit])[1].body));
  return { protocol, values, writes, queue, fetchMock, verify, verifyGoogle, revoke, consent, admit, set, get, accept, google, complete, body };
}

describe("Identity session verification and refresh", () => {
  it("does not call any provider for an anonymous visitor", async () => { const f = fixture(); expect(await f.protocol.verifiedIdentity()).toBeNull(); expect(f.fetchMock).not.toHaveBeenCalled(); expect(f.verify).not.toHaveBeenCalled(); });
  it("only derives identity from the verifier and preserves the provider", async () => {
    const f = fixture(); f.set("id", TOKEN); const identity = await f.protocol.verifiedIdentity();
    expect(identity).toMatchObject({ subject: "user-one", emailVerified: true, provider: "google.com" }); expect(f.verify).toHaveBeenCalledWith(TOKEN);
  });
  it("does not grant a database identity to an unverified email", async () => { const f = fixture(); f.set("id", TOKEN); f.verify.mockResolvedValue(decoded({ email_verified: false })); expect(await f.protocol.verifiedIdentity()).toBeNull(); });
  it.each(["auth/id-token-revoked", "auth/user-disabled", "auth/user-not-found", "auth/argument-error", "auth/invalid-id-token"])("clears %s and never refreshes it", async (code) => {
    const f = fixture(); f.set("id", TOKEN); f.set("refresh", SECRET); f.verify.mockRejectedValue({ code, message: SECRET });
    expect(await f.protocol.session()).toBeNull(); expect(f.get("id")).toBe(""); expect(f.get("refresh")).toBe(""); expect(f.fetchMock).not.toHaveBeenCalled();
  });
  it("returns a fixed unavailable error for verifier transport failures without logging secrets", async () => {
    const f = fixture(); f.set("id", TOKEN); f.verify.mockRejectedValue(new Error(SECRET));
    await expect(f.protocol.session()).rejects.toThrow("Identity operation failed (unavailable); details withheld."); expect(f.fetchMock).not.toHaveBeenCalled();
  });
  it("refreshes only a known expired token and verifies the newly issued token", async () => {
    const f = fixture(); f.set("id", TOKEN); f.set("refresh", "old-refresh"); f.verify.mockRejectedValueOnce({ code: "auth/id-token-expired" });
    f.queue.push({ data: { id_token: TOKEN, refresh_token: "rotated-refresh" } });
    expect((await f.protocol.session())?.identity.subject).toBe("user-one"); expect(f.verify).toHaveBeenCalledTimes(2); expect(f.get("refresh")).toBe("rotated-refresh");
    const [url, options] = f.fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.origin).toBe("https://securetoken.googleapis.com"); expect(options.body).toBe("grant_type=refresh_token&refresh_token=old-refresh");
  });
  it("rejects a changed subject on refresh", async () => {
    const f = fixture(); f.set("id", TOKEN); f.set("refresh", "old-refresh");
    f.verify.mockRejectedValueOnce({ code: "auth/id-token-expired" }).mockResolvedValue(decoded({ uid: "other", sub: "other" })); f.accept();
    expect(await f.protocol.session()).toBeNull(); expect(f.get("id")).toBe("");
  });
  it("does not authorize a forged token payload", () => { expect(() => identityFromToken(decoded({ sub: "other" }))).toThrow(IdentityError); });
  it.each(["recovery-tenant", "", undefined])("rejects a tenant-scoped token even when its UID matches (%s)", (tenant) => {
    expect(() => identityFromToken(decoded({ firebase: { sign_in_provider: "google.com", identities: {}, tenant } }))).toThrow(IdentityError);
  });
  it("does not erase a session during an upstream 503", async () => {
    const f = fixture(); f.set("id", TOKEN); f.set("refresh", "old-refresh"); f.verify.mockRejectedValueOnce({ code: "auth/id-token-expired" }); f.queue.push({ status: 503, data: { error: { message: SECRET } } });
    await expect(f.protocol.session()).rejects.toThrow("unavailable"); expect(f.get("refresh")).toBe("old-refresh");
  });
  it("sets only host-bound HttpOnly secure Lax cookies", async () => {
    const f = fixture(); f.accept(); await f.protocol.passwordLogin("fixture@example.com", "test-password");
    expect(f.writes).toHaveLength(3);
    for (const write of f.writes) {
      expect(write.name).toMatch(/^__Host-mfmf-idp-/);
      expect(write.options).toEqual({ httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: write.name.endsWith("-csrf") ? 0 : 2592000 });
    }
    expect(f.get("csrf")).toBe("");
  });
});

describe("Same-origin authentication mutations", () => {
  it("requires both configured Origin and browser-bound CSRF token", () => {
    const f = fixture(); const csrf = f.protocol.csrfToken(); expect(f.get("csrf")).toBe(csrf);
    const request = (origin: string, site?: string, token = csrf) => ({ headers: new Headers({ origin, "x-mfmf-csrf": token, ...(site ? { "sec-fetch-site": site } : {}) }) });
    expect(f.protocol.allowsMutation(request(config.origin, "same-origin"))).toBe(true);
    expect(f.protocol.allowsMutation(request(config.origin))).toBe(true);
    for (const site of ["cross-site", "same-site", "none", "same-origin, same-site"]) expect(f.protocol.allowsMutation(request(config.origin, site))).toBe(false);
    expect(f.protocol.allowsMutation(request("https://evil.example", "same-origin"))).toBe(false);
    expect(f.protocol.allowsMutation(request(config.origin, "same-origin", "x".repeat(43)))).toBe(false);
    expect(f.protocol.allowsMutation({ headers: new Headers() })).toBe(false);
  });
  it("ignores forwarded host headers for origin decisions", () => {
    const f = fixture(); f.protocol.csrfToken();
    expect(f.protocol.allowsMutation({ headers: new Headers({ origin: "https://evil.example", "x-forwarded-host": "app.example", "sec-fetch-site": "same-origin", "x-mfmf-csrf": NONCE }) })).toBe(false);
  });
});

describe("Interactive login invalidates forms shown under the previous identity", () => {
  const oldCsrf = "a".repeat(43);
  const mutation = (csrf = oldCsrf) => ({ headers: new Headers({ origin: config.origin, "sec-fetch-site": "same-origin", "x-mfmf-csrf": csrf }) });

  it("rejects a stale consent after an invalidated account logs in as another account", async () => {
    const f = fixture(); f.set("id", TOKEN); f.set("refresh", "old-refresh"); f.set("csrf", oldCsrf);
    expect((await f.protocol.verifiedIdentity())?.subject).toBe("user-one");
    expect(f.protocol.allowsMutation(mutation())).toBe(true);
    f.verify.mockRejectedValueOnce({ code: "auth/id-token-revoked" });
    expect(await f.protocol.verifiedIdentity()).toBeNull();
    f.verify.mockResolvedValue(decoded({ sub: "user-two", uid: "user-two", email: "second@example.test" }));
    f.queue.push({ data: { idToken: "fictional-second-id-token", refreshToken: "fictional-second-refresh" } });
    await f.protocol.passwordLogin("second@example.test", "test-password");
    expect((await f.protocol.verifiedIdentity())?.subject).toBe("user-two");
    expect(f.protocol.allowsMutation(mutation())).toBe(false);
    const currentCsrf = f.protocol.csrfToken();
    expect(currentCsrf).not.toBe(oldCsrf);
    expect(f.protocol.allowsMutation(mutation(currentCsrf))).toBe(true);
  });

  it("invalidates old forms even when password login replaces them with an unverified session", async () => {
    const f = fixture(); f.set("csrf", oldCsrf); f.accept();
    f.verify.mockResolvedValue(decoded({ sub: "user-two", uid: "user-two", email_verified: false }));
    await expect(f.protocol.passwordLogin("second@example.test", "test-password")).rejects.toMatchObject({ code: "unverified" });
    expect(f.protocol.allowsMutation(mutation())).toBe(false);
  });

  it("invalidates old forms after a successfully verified Google account replacement", async () => {
    const f = fixture(); f.set("id", TOKEN); f.set("csrf", oldCsrf);
    f.google(); await f.protocol.beginGoogle(); f.complete();
    f.verify.mockResolvedValue(decoded({ sub: "user-two", uid: "user-two", email: "second@example.test" }));
    expect((await f.protocol.finishGoogle(new URLSearchParams({ code: "one-use-code", state: STATE }))).identity.subject).toBe("user-two");
    expect(f.protocol.allowsMutation(mutation())).toBe(false);
  });

  it("invalidates old forms when signup replaces the browser session", async () => {
    const f = fixture(); f.set("id", TOKEN); f.set("csrf", oldCsrf);
    f.accept(); f.queue.push({ data: {} });
    f.verify.mockResolvedValue(decoded({ sub: "user-two", uid: "user-two", email_verified: false }));
    await f.protocol.signup("second@example.test", "test-password", true);
    expect(f.protocol.allowsMutation(mutation())).toBe(false);
  });

  it("keeps a same-subject background refresh's current form valid", async () => {
    const f = fixture(); f.set("id", TOKEN); f.set("refresh", "old-refresh"); f.set("csrf", oldCsrf);
    f.verify.mockRejectedValueOnce({ code: "auth/id-token-expired" });
    f.queue.push({ data: { id_token: TOKEN, refresh_token: "rotated-refresh" } });
    expect((await f.protocol.verifiedIdentity())?.subject).toBe("user-one");
    expect(f.protocol.allowsMutation(mutation())).toBe(true);
  });

  it("keeps current forms and session on a rejected login attempt", async () => {
    const f = fixture(); f.set("id", TOKEN); f.set("csrf", oldCsrf);
    f.queue.push({ status: 400, data: { error: { message: "INVALID_LOGIN_CREDENTIALS" } } });
    await expect(f.protocol.passwordLogin("second@example.test", "wrong-password")).rejects.toThrow(IdentityError);
    expect(f.get("id")).toBe(TOKEN);
    expect(f.protocol.allowsMutation(mutation())).toBe(true);
  });
});

describe("Password and managed email flows", () => {
  it("calls only the fixed REST method and never returns an ID token to the caller", async () => {
    const f = fixture(); f.accept(); expect(await f.protocol.passwordLogin("fixture@example.com", "test-password")).toBeUndefined();
    const [url, init] = f.fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.origin).toBe("https://identitytoolkit.googleapis.com"); expect(url.pathname).toBe("/v1/accounts:signInWithPassword");
    expect(init).toMatchObject({ redirect: "error", credentials: "omit", cache: "no-store" });
  });
  it("holds an unverified session only for email verification, not application access", async () => {
    const f = fixture(); f.accept(); f.verify.mockResolvedValue(decoded({ email_verified: false }));
    await expect(f.protocol.passwordLogin("fixture@example.com", "test-password")).rejects.toMatchObject({ code: "unverified" });
    expect(await f.protocol.verifiedIdentity()).toBeNull();
    expect(f.admit).not.toHaveBeenCalled();
  });
  it("does not issue password-login cookies before persistent database admission", async () => {
    const f = fixture(); f.accept(); f.admit.mockRejectedValue(new Error("not imported"));
    await expect(f.protocol.passwordLogin("fixture@example.com", "test-password")).rejects.toThrow(IdentityError);
    expect(f.get("id")).toBeUndefined(); expect(f.get("refresh")).toBeUndefined();
  });
  it("enforces signup disabled before sending credentials", async () => {
    const f = fixture(); f.protocol.config.signupEnabled = false;
    try { await expect(f.protocol.signup("fixture@example.com", "test-password", true)).rejects.toMatchObject({ code: "disabled" }); expect(f.fetchMock).not.toHaveBeenCalled(); }
    finally { f.protocol.config.signupEnabled = true; }
  });
  it.each([["short", true], ["test-password", false], ["test-password", undefined]])("requires password policy and explicit terms consent", async (password, consent) => {
    const f = fixture(); await expect(f.protocol.signup("fixture@example.com", password, consent)).rejects.toThrow(IdentityError); expect(f.fetchMock).not.toHaveBeenCalled();
  });
  it("records consent after verification and sends email using a fixed continue URL", async () => {
    const f = fixture(); f.accept(); f.queue.push({ data: {} }); await f.protocol.signup("fixture@example.com", "test-password", true);
    expect(f.consent).toHaveBeenCalledWith("user-one", new Date(NOW).toISOString());
    expect(f.body(1)).toMatchObject({ requestType: "VERIFY_EMAIL", continueUrl: "https://app.example/auth/identity/continue" });
  });
  it.each([400, 429, 503])("keeps reset-mail response uniform on HTTP %s", async (status) => {
    const f = fixture(); f.queue.push({ status, data: { error: { message: SECRET } } }); expect(await f.protocol.forgotPassword("fixture@example.com")).toBeUndefined();
  });
  it("requires an authenticated verified session for settings password update", async () => { const f = fixture(); await expect(f.protocol.updatePassword("new-password")).rejects.toThrow(IdentityError); expect(f.fetchMock).not.toHaveBeenCalled(); });
  it("uses a user ID token, never an Admin bypass, for password update", async () => {
    const f = fixture(); f.set("id", TOKEN); f.accept(); await f.protocol.updatePassword("new-password"); expect(f.body(0)).toEqual({ idToken: TOKEN, password: "new-password", returnSecureToken: true });
  });
  it("uses a generic error for recent-login requirements", async () => {
    const f = fixture(); f.set("id", TOKEN); f.queue.push({ status: 400, data: { error: { message: "CREDENTIAL_TOO_OLD_LOGIN_AGAIN" } } });
    await expect(f.protocol.updatePassword("new-password")).rejects.toMatchObject({ code: "recent-login" });
  });
  it("requires a current browser session to continue after the hosted email handler", async () => {
    const f = fixture(); expect(await f.protocol.continueEmail()).toBe(false); expect(f.fetchMock).not.toHaveBeenCalled();
  });
  it("refreshes the same pending subject after hosted verification", async () => {
    const f = fixture(); f.set("id", TOKEN); f.set("refresh", "pending-refresh");
    f.verify.mockResolvedValueOnce(decoded({ email_verified: false })).mockResolvedValue(decoded()); f.accept();
    expect(await f.protocol.continueEmail()).toBe(true); expect(f.admit).toHaveBeenCalledWith(expect.objectContaining({ subject: "user-one" }));
  });
  it("does not resurrect a session revoked by hosted password reset", async () => {
    const f = fixture(); f.set("id", TOKEN); f.set("refresh", "pending-refresh"); f.verify.mockRejectedValue({ code: "auth/id-token-revoked" });
    expect(await f.protocol.continueEmail()).toBe(false); expect(f.fetchMock).not.toHaveBeenCalled(); expect(f.get("refresh")).toBe("");
  });
  it("rejects an identity switch during hosted email continuation", async () => {
    const f = fixture(); f.set("id", TOKEN); f.set("refresh", "pending-refresh"); f.accept();
    f.verify.mockResolvedValueOnce(decoded()).mockResolvedValue(decoded({ sub: "other", uid: "other" }));
    expect(await f.protocol.continueEmail()).toBe(false); expect(f.get("id")).toBe("");
  });
  it("never grants access before email is verified after hosted continuation", async () => {
    const f = fixture(); f.set("id", TOKEN); f.set("refresh", "pending-refresh"); f.accept(); f.verify.mockResolvedValue(decoded({ email_verified: false }));
    expect(await f.protocol.continueEmail()).toBe(false); expect(f.admit).not.toHaveBeenCalled();
  });
  it("revokes all refresh sessions at signout and clears local credentials", async () => {
    const f = fixture(); f.set("id", TOKEN); await f.protocol.signout(); expect(f.revoke).toHaveBeenCalledWith("user-one"); expect(f.get("id")).toBe(""); expect(f.get("refresh")).toBe("");
  });
  it("retains the session on global-revocation failure so the operation can be retried", async () => {
    const f = fixture(); f.set("id", TOKEN); f.revoke.mockRejectedValue(new Error(SECRET)); await expect(f.protocol.signout()).rejects.toThrow("unavailable"); expect(f.get("id")).toBe(TOKEN);
  });
});

describe("Server-driven Google OAuth", () => {
  it("requests code flow, offline Drive consent and nonce, storing the session only in HttpOnly cookies", async () => {
    const f = fixture(); f.google(); const url = await f.protocol.beginGoogle(); expect(new URL(url).origin).toBe("https://accounts.google.com");
    expect(f.body(0)).toMatchObject({ authFlowType: "CODE_FLOW", continueUri: "https://app.example/auth/callback", customParameter: { access_type: "offline", prompt: "consent", nonce: NONCE } });
    expect(f.writes[0].options).toMatchObject({ httpOnly: true, secure: true, maxAge: 600 }); expect(url).not.toContain("provider-session");
  });
  it.each(["https://evil.example/", "http://accounts.google.com/o/oauth2/v2/auth", "https://accounts.google.com.evil.example/", "https://user@accounts.google.com/o/oauth2/v2/auth", "https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https://evil.example"])("rejects untrusted authorization URI %s", async (url) => {
    const f = fixture(); f.google(url); await expect(f.protocol.beginGoogle()).rejects.toThrow(); expect(f.get("google")).toBeUndefined();
  });
  it("checks Google signed nonce/audience and IdP linked subject before accepting tokens", async () => {
    const f = fixture(); f.google(); await f.protocol.beginGoogle(); f.complete();
    expect(await f.protocol.finishGoogle(new URLSearchParams({ code: "one-use-code", state: STATE }))).toMatchObject({ identity: { subject: "user-one" }, refreshToken: "drive-refresh-token" });
    expect(f.verifyGoogle).toHaveBeenCalledWith("google-token", config.googleClientId); expect(f.get("google")).toBe("");
    expect(f.body(1)).toEqual({ requestUri: `https://app.example/auth/callback?code=one-use-code&state=${STATE}`, sessionId: "provider-session", returnSecureToken: true, returnRefreshToken: true, returnIdpCredential: false });
  });
  it.each(["error=access_denied&state=provider-generated-state", "code=code&state=wrong", "code=code", "code=code&state=provider-generated-state&state=duplicate", "code=first&code=second&state=provider-generated-state"])("rejects cancellation, missing/mismatched/duplicate state or code: %s", async (query) => {
    const f = fixture(); f.google(); await f.protocol.beginGoogle(); await expect(f.protocol.finishGoogle(new URLSearchParams(query))).rejects.toThrow(IdentityError);
    expect(f.fetchMock).toHaveBeenCalledTimes(1); expect(f.get("google")).toBe("");
  });
  it("does not exchange without a browser-bound flow cookie", async () => { const f = fixture(); await expect(f.protocol.finishGoogle(new URLSearchParams({ code: "code", state: STATE }))).rejects.toThrow(IdentityError); expect(f.fetchMock).not.toHaveBeenCalled(); });
  it.each(["nonce", "subject", "signature"])("rejects a Google %s mismatch without setting the session", async (failure) => {
    const f = fixture(); f.google(); await f.protocol.beginGoogle(); f.complete();
    if (failure === "signature") f.verifyGoogle.mockRejectedValue(new Error(SECRET)); else f.verifyGoogle.mockResolvedValue({ sub: failure === "subject" ? "other" : "google-subject", nonce: failure === "nonce" ? "wrong" : NONCE });
    await expect(f.protocol.finishGoogle(new URLSearchParams({ code: "code", state: STATE }))).rejects.toThrow(IdentityError); expect(f.get("id")).toBeUndefined();
  });
  it("does not pass an ID token for implicit account linking", async () => {
    const f = fixture(); f.google(); await f.protocol.beginGoogle(); f.complete(); await f.protocol.finishGoogle(new URLSearchParams({ code: "code", state: STATE })); expect(f.body(1)).not.toHaveProperty("idToken");
  });
  it("requires an explicit provider account link and verified email", async () => {
    const f = fixture(); f.google(); await f.protocol.beginGoogle(); f.complete(); f.verify.mockResolvedValue(decoded({ firebase: { identities: {}, sign_in_provider: "google.com" } }));
    await expect(f.protocol.finishGoogle(new URLSearchParams({ code: "code", state: STATE }))).rejects.toThrow(IdentityError);
  });
  it("cannot replay a consumed callback", async () => {
    const f = fixture(); f.google(); await f.protocol.beginGoogle(); f.complete(); const query = new URLSearchParams({ code: "code", state: STATE });
    await f.protocol.finishGoogle(query); await expect(f.protocol.finishGoogle(query)).rejects.toThrow(IdentityError); expect(f.fetchMock).toHaveBeenCalledTimes(2);
  });
  it("rejects provider account-confirmation ambiguity", async () => {
    const f = fixture(); f.google(); await f.protocol.beginGoogle(); f.complete({ needConfirmation: true });
    await expect(f.protocol.finishGoogle(new URLSearchParams({ code: "code", state: STATE }))).rejects.toThrow(IdentityError); expect(f.verifyGoogle).not.toHaveBeenCalled();
  });
  it("cannot bypass closed-signup admission by retrying an already-created IdP account", async () => {
    const f = fixture(); f.protocol.config.signupEnabled = false;
    try {
      f.google(); await f.protocol.beginGoogle(); f.complete({ isNewUser: true });
      await expect(f.protocol.finishGoogle(new URLSearchParams({ code: "first", state: STATE }))).rejects.toThrow(IdentityError);
      f.google(); await f.protocol.beginGoogle(); f.complete({ isNewUser: false }); f.admit.mockRejectedValue(new Error("mapping absent"));
      await expect(f.protocol.finishGoogle(new URLSearchParams({ code: "second", state: STATE }))).rejects.toThrow(IdentityError);
      expect(f.get("id")).toBeUndefined(); expect(f.get("refresh")).toBeUndefined();
    } finally { f.protocol.config.signupEnabled = true; }
  });
});

describe("Bounded provider response and configuration", () => {
  beforeEach(() => { vi.unstubAllEnvs(); });
  it("bounds chunked response bodies and withholds provider content", async () => {
    const f = fixture(); f.fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: SECRET.repeat(10000) } }), { status: 400 }));
    await expect(f.protocol.passwordLogin("fixture@example.com", "password")).rejects.toThrow("unavailable");
  });
  it("has an opt-in flag and rejects inconsistent client/server flags", () => {
    vi.stubEnv("GCP_AUTH_ENABLED", "false"); expect(isGcpAuthEnabled()).toBe(false);
    vi.stubEnv("GCP_AUTH_ENABLED", "true"); vi.stubEnv("NEXT_PUBLIC_GCP_AUTH_ENABLED", "false"); expect(() => identityConfig()).toThrow("configuration");
  });
});
