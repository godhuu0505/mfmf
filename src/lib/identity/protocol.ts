import "server-only";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { DecodedIdToken } from "firebase-admin/auth";
import type { VerifiedIdentity } from "@/lib/gcp/dataClient";
import type { IdentityConfig } from "./config";

export type CookieOptions = { httpOnly: boolean; secure: boolean; sameSite: "lax"; path: "/"; maxAge: number };
export interface IdentityCookies { get(name: string): string | undefined; set(name: string, value: string, options: CookieOptions): void }
export interface IdentityDependencies {
  fetch: typeof fetch;
  verify: (token: string) => Promise<DecodedIdToken>;
  verifyGoogle: (token: string, audience: string) => Promise<{ sub?: string; nonce?: string }>;
  revoke: (subject: string) => Promise<void>;
  recordConsent: (subject: string, at: string) => Promise<void>;
  admit: (identity: VerifiedIdentity) => Promise<void>;
  now?: () => number;
  random?: () => string;
}
type Json = Record<string, unknown>;
type Session = { identity: VerifiedIdentity; token: string; decoded: DecodedIdToken };
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const FLOW_SECONDS = 10 * 60;
const REJECTED_TOKEN_CODES = new Set(["auth/id-token-revoked", "auth/user-disabled", "auth/user-not-found", "auth/argument-error", "auth/invalid-id-token"]);
const METHOD = new Set(["signInWithPassword", "signUp", "sendOobCode", "update", "createAuthUri", "signInWithIdp"]);

export class IdentityError extends Error {
  constructor(public readonly code: "invalid" | "unverified" | "expired" | "unavailable" | "disabled" | "recent-login" = "invalid") {
    super(`Identity operation failed (${code}); details withheld.`);
  }
}
function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new IdentityError("unavailable");
  return value as Json;
}
function text(value: unknown, max = 3800): string {
  if (typeof value !== "string" || !value || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new IdentityError();
  return value;
}
function same(a: string, b: string): boolean {
  const aa = Buffer.from(a); const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
export function identityFromToken(decoded: DecodedIdToken): VerifiedIdentity {
  const subject = text(decoded.sub, 128);
  // This application uses the project's default user namespace. A separately
  // signed tenant token must never alias a default-namespace UID (including
  // accounts imported into an isolated recovery-test tenant).
  if (decoded.firebase && Object.hasOwn(decoded.firebase, "tenant")) throw new IdentityError();
  if (decoded.uid !== subject || typeof decoded.email_verified !== "boolean") throw new IdentityError();
  return { subject, email: typeof decoded.email === "string" ? text(decoded.email, 320) : null,
    emailVerified: decoded.email_verified === true,
    ...(typeof decoded.name === "string" ? { displayName: decoded.name.slice(0, 256) } : {}),
    ...(typeof decoded.picture === "string" ? { picture: decoded.picture.slice(0, 2048) } : {}),
    ...(typeof decoded.auth_time === "number" ? { authTime: decoded.auth_time } : {}),
    ...(typeof decoded.firebase?.sign_in_provider === "string" ? { provider: decoded.firebase.sign_in_provider } : {}) };
}

/** Fixed Google endpoints only. Provider bodies, bearer tokens and exceptions never escape this module. */
export class IdentityProtocol {
  private readonly now: () => number;
  private readonly random: () => string;
  constructor(readonly config: IdentityConfig, private readonly deps: IdentityDependencies, readonly cookies: IdentityCookies) {
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? (() => randomBytes(32).toString("base64url"));
  }
  name(kind: string): string { return `${this.config.secure ? "__Host-" : ""}mfmf-idp-${kind}`; }
  private put(kind: string, value: string, maxAge = SESSION_SECONDS) {
    if (Buffer.byteLength(value) > 3800) throw new IdentityError();
    this.cookies.set(this.name(kind), value, { httpOnly: true, secure: this.config.secure, sameSite: "lax", path: "/", maxAge });
  }
  private read(kind: string) { return this.cookies.get(this.name(kind)); }
  private clear(kind: string) { this.put(kind, "", 0); }
  clearSession() { this.clear("id"); this.clear("refresh"); }
  csrfToken() {
    const existing = this.read("csrf");
    if (existing && /^[A-Za-z0-9_-]{43}$/.test(existing)) return existing;
    const token = this.random(); this.put("csrf", token, 3600); return token;
  }
  allowsOrigin(request: Pick<Request, "headers">): boolean {
    const site = request.headers.get("sec-fetch-site");
    return request.headers.get("origin") === this.config.origin && (site === null || site === "same-origin");
  }
  allowsMutation(request: Pick<Request, "headers">): boolean {
    const csrf = request.headers.get("x-mfmf-csrf");
    const expected = this.read("csrf");
    return this.allowsOrigin(request) &&
      !!csrf && !!expected && /^[A-Za-z0-9_-]{43}$/.test(csrf) && same(csrf, expected);
  }
  private async request(method: string, payload: Json, refresh = false): Promise<Json> {
    if ((!refresh && !METHOD.has(method)) || (refresh && method !== "token")) throw new IdentityError();
    const url = new URL(refresh ? "https://securetoken.googleapis.com/v1/token" : `https://identitytoolkit.googleapis.com/v1/accounts:${method}`);
    url.searchParams.set("key", this.config.apiKey);
    try {
      const response = await this.deps.fetch(url, { method: "POST", redirect: "error", cache: "no-store", credentials: "omit",
        signal: AbortSignal.timeout(15_000), headers: { "content-type": refresh ? "application/x-www-form-urlencoded" : "application/json" },
        body: refresh ? new URLSearchParams(payload as Record<string, string>).toString() : JSON.stringify(payload) });
      if (Number(response.headers.get("content-length")) > 64 * 1024) throw new IdentityError("unavailable");
      // Bound decoded bytes too: chunked responses must not bypass Content-Length.
      const reader = response.body?.getReader(); let length = 0; const parts: Uint8Array[] = [];
      if (!reader) throw new IdentityError("unavailable");
      try { while (true) { const { value, done } = await reader.read(); if (done) break;
        length += value.byteLength; if (length > 64 * 1024) { await reader.cancel(); throw new IdentityError("unavailable"); } parts.push(value); } }
      finally { reader.releaseLock(); }
      const data = object(JSON.parse(Buffer.concat(parts).toString("utf8")));
      if (!response.ok) {
        const error = data.error && typeof data.error === "object" ? (data.error as Json).message : undefined;
        if (error === "CREDENTIAL_TOO_OLD_LOGIN_AGAIN") throw new IdentityError("recent-login");
        throw new IdentityError(response.status >= 500 || response.status === 429 ? "unavailable" : "invalid");
      }
      return data;
    } catch (error) { if (error instanceof IdentityError) throw error; throw new IdentityError("unavailable"); }
  }
  private async checked(token: string): Promise<Session> {
    const decoded = await this.deps.verify(text(token));
    return { identity: identityFromToken(decoded), token, decoded };
  }
  private async accept(data: Json, expectedSubject?: string): Promise<Session> {
    const token = text(data.idToken ?? data.id_token);
    const refresh = text(data.refreshToken ?? data.refresh_token);
    let session: Session;
    try { session = await this.checked(token); } catch { throw new IdentityError(); }
    if (expectedSubject && session.identity.subject !== expectedSubject) throw new IdentityError();
    if (session.identity.emailVerified && session.identity.email) {
      // Admission is persistent: an IdP user created by a previous rejected
      // OAuth attempt must not become admissible merely because isNewUser=false.
      try { await this.deps.admit(session.identity); } catch { throw new IdentityError("unavailable"); }
    }
    this.put("id", token); this.put("refresh", refresh);
    return session;
  }
  async session(): Promise<Session | null> {
    const token = this.read("id"); if (!token) return null;
    try { return await this.checked(token); } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code !== "auth/id-token-expired") {
        if (error instanceof IdentityError || (typeof code === "string" && REJECTED_TOKEN_CODES.has(code))) { this.clearSession(); return null; }
        throw new IdentityError("unavailable");
      }
    }
    // This unverified claim is used only to reject a mismatched refreshed identity,
    // never to authenticate or authorize a database request.
    let expected: string;
    try { expected = text(object(JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString())).sub, 128); }
    catch { this.clearSession(); return null; }
    const refresh = this.read("refresh"); if (!refresh) { this.clearSession(); return null; }
    try { return await this.accept(await this.request("token", { grant_type: "refresh_token", refresh_token: text(refresh) }, true), expected); }
    catch (error) { if (error instanceof IdentityError && error.code === "unavailable") throw error; this.clearSession(); return null; }
  }
  async verifiedIdentity(): Promise<VerifiedIdentity | null> {
    const session = await this.session(); return session?.identity.emailVerified && session.identity.email ? session.identity : null;
  }
  private credentials(email: unknown, password: unknown) {
    const checkedEmail = text(email, 320).trim(); const checkedPassword = text(password, 1024);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(checkedEmail)) throw new IdentityError();
    return { email: checkedEmail, password: checkedPassword };
  }
  async passwordLogin(email: unknown, password: unknown) {
    const session = await this.accept(await this.request("signInWithPassword", { ...this.credentials(email, password), returnSecureToken: true }));
    if (!session.identity.emailVerified || !session.identity.email) throw new IdentityError("unverified");
  }
  async signup(email: unknown, password: unknown, acceptedTerms: unknown) {
    if (!this.config.signupEnabled) throw new IdentityError("disabled");
    const credentials = this.credentials(email, password);
    if (credentials.password.length < 8 || acceptedTerms !== true) throw new IdentityError();
    const data = await this.request("signUp", { ...credentials, returnSecureToken: true });
    const session = await this.accept(data);
    try { await this.deps.recordConsent(session.identity.subject, new Date(this.now()).toISOString()); }
    catch { this.clearSession(); throw new IdentityError("unavailable"); }
    await this.request("sendOobCode", { requestType: "VERIFY_EMAIL", idToken: session.token,
      continueUrl: `${this.config.origin}/auth/identity/continue`, canHandleCodeInApp: false });
  }
  async forgotPassword(email: unknown) {
    try { await this.request("sendOobCode", { requestType: "PASSWORD_RESET", email: text(email, 320).trim(),
      continueUrl: `${this.config.origin}/auth/identity/continue`, canHandleCodeInApp: false }); }
    catch { /* Uniform response, including missing accounts, throttling and upstream failure. */ }
  }
  async beginGoogle(): Promise<string> {
    const nonce = this.random();
    const data = await this.request("createAuthUri", { providerId: "google.com", continueUri: `${this.config.origin}/auth/callback`,
      authFlowType: "CODE_FLOW", oauthScope: "openid email profile https://www.googleapis.com/auth/drive.file",
      customParameter: { access_type: "offline", prompt: "consent", nonce } });
    const uri = new URL(text(data.authUri, 8192));
    const state = uri.searchParams.get("state");
    if (data.providerId !== "google.com" || uri.origin !== "https://accounts.google.com" || uri.username || uri.password || uri.hash ||
        !["/o/oauth2/auth", "/o/oauth2/v2/auth"].includes(uri.pathname) ||
        uri.searchParams.get("client_id") !== this.config.googleClientId || uri.searchParams.get("redirect_uri") !== `${this.config.origin}/auth/callback` ||
        uri.searchParams.get("nonce") !== nonce || uri.searchParams.get("response_type") !== "code" || !state) throw new IdentityError();
    this.put("google", Buffer.from(JSON.stringify({ sessionId: text(data.sessionId, 1024), state: text(state, 1024), nonce,
      expires: this.now() + FLOW_SECONDS * 1000 })).toString("base64url"), FLOW_SECONDS);
    return uri.href;
  }
  async finishGoogle(search: URLSearchParams): Promise<{ identity: VerifiedIdentity; refreshToken?: string }> {
    const pending = this.read("google"); this.clear("google"); // Consume on cancellation and every failed exchange too.
    let flow: Json;
    try { flow = object(JSON.parse(Buffer.from(text(pending), "base64url").toString())); } catch { throw new IdentityError(); }
    const state = search.get("state");
    if (typeof flow.expires !== "number" || flow.expires <= this.now() || !state || search.getAll("state").length !== 1 ||
        !same(state, text(flow.state, 1024)) || search.has("error") || search.getAll("code").length !== 1) throw new IdentityError();
    const callback = new URL(`${this.config.origin}/auth/callback`);
    callback.searchParams.set("code", text(search.get("code"), 4096)); callback.searchParams.set("state", state);
    const data = await this.request("signInWithIdp", { requestUri: callback.href, sessionId: text(flow.sessionId, 1024), returnSecureToken: true, returnRefreshToken: true, returnIdpCredential: false });
    if (data.providerId !== "google.com" || data.needConfirmation || (!this.config.signupEnabled && data.isNewUser === true)) throw new IdentityError();
    let google: { sub?: string; nonce?: string };
    try { google = await this.deps.verifyGoogle(text(data.oauthIdToken), this.config.googleClientId); } catch { throw new IdentityError(); }
    if (!google.sub || !google.nonce || !same(google.nonce, text(flow.nonce))) throw new IdentityError();
    const token = text(data.idToken); let verified: Session;
    try { verified = await this.checked(token); } catch { throw new IdentityError(); }
    if (!verified.identity.emailVerified || !verified.identity.email || verified.identity.provider !== "google.com" ||
        !verified.decoded.firebase.identities["google.com"]?.includes(google.sub)) throw new IdentityError();
    const session = await this.accept(data, verified.identity.subject);
    return { identity: session.identity, ...(data.oauthRefreshToken ? { refreshToken: text(data.oauthRefreshToken) } : {}) };
  }
  async continueEmail(): Promise<boolean> {
    const session = await this.session(); const refresh = this.read("refresh");
    if (!session || !refresh) return false;
    try {
      const updated = await this.accept(await this.request("token", { grant_type: "refresh_token", refresh_token: text(refresh) }, true), session.identity.subject);
      return updated.identity.emailVerified && !!updated.identity.email;
    } catch (error) {
      if (error instanceof IdentityError && error.code === "unavailable") throw error;
      this.clearSession(); return false;
    }
  }
  async updatePassword(password: unknown) {
    const checkedPassword = text(password, 1024); if (checkedPassword.length < 8) throw new IdentityError();
    const session = await this.session();
    if (!session?.identity.emailVerified) throw new IdentityError();
    const data = await this.request("update", { idToken: session.token, password: checkedPassword, returnSecureToken: true });
    await this.accept(data, session.identity.subject);
  }
  async signout() {
    const session = await this.session();
    try { if (session) await this.deps.revoke(session.identity.subject); }
    catch { throw new IdentityError("unavailable"); }
    // Retain the local session if global revocation fails, so retry can still
    // authenticate the account and revoke its other sessions.
    this.clearSession(); this.clear("google"); this.clear("csrf");
  }
}
