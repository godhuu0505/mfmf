import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { IdentityError } from "@/lib/identity/protocol";
import { POST_LOGIN_NEXT_COOKIE } from "@/lib/nextPath";

const mocks = vi.hoisted(() => ({
  protocol: { csrfToken: vi.fn(), allowsMutation: vi.fn(), allowsOrigin: vi.fn(), passwordLogin: vi.fn(), signup: vi.fn(),
    forgotPassword: vi.fn(), beginGoogle: vi.fn(), updatePassword: vi.fn(), continueEmail: vi.fn(), finishGoogle: vi.fn(), clearSession: vi.fn(), signout: vi.fn() },
  bridge: vi.fn(), mode: vi.fn(), saveGoogle: vi.fn(), getProtocol: vi.fn(), legacy: vi.fn(),
}));
vi.mock("@/lib/identity/server", () => ({ getIdentityProtocol: mocks.getProtocol }));
vi.mock("@/lib/gcp/dataClient", () => ({ createGcpDataClient: mocks.bridge }));
vi.mock("@/lib/google/token", () => ({ saveGoogleRefreshToken: mocks.saveGoogle }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.legacy }));

import { GET as csrf, POST as mutate } from "@/app/auth/identity/session/route";
import { GET as continuation } from "@/app/auth/identity/continue/route";
import { GET as callback } from "@/app/auth/callback/route";
import { POST as signout } from "@/app/auth/signout/route";

function request(path: string, body?: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`https://0.0.0.0:8080${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }),
      cookie: `${POST_LOGIN_NEXT_COOKIE}=${encodeURIComponent("/invite/fixture")}`, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("GCP_AUTH_ENABLED", "true"); vi.stubEnv("NEXT_PUBLIC_GCP_AUTH_ENABLED", "true");
  mocks.getProtocol.mockResolvedValue(mocks.protocol); mocks.protocol.csrfToken.mockReturnValue("fixture-csrf");
  mocks.protocol.allowsMutation.mockReturnValue(true); mocks.protocol.allowsOrigin.mockReturnValue(true);
  mocks.mode.mockResolvedValue({ data: "gcs", error: null });
  mocks.bridge.mockResolvedValue({ client: { fixture: "client", rpc: mocks.mode }, user: { id: "internal-uuid" } });
  mocks.protocol.finishGoogle.mockResolvedValue({ identity: { subject: "external-subject" }, refreshToken: "provider-refresh-marker" });
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("Identity BFF request boundaries", () => {
  it("disables all new API behavior while the migration flag is off", async () => {
    vi.stubEnv("GCP_AUTH_ENABLED", "false"); vi.stubEnv("NEXT_PUBLIC_GCP_AUTH_ENABLED", "false");
    expect((await csrf()).status).toBe(404); expect((await mutate(request("/auth/identity/session", { operation: "password" }))).status).toBe(404);
    expect(mocks.getProtocol).not.toHaveBeenCalled();
  });
  it("returns only the CSRF token and marks it no-store", async () => {
    const response = await csrf(); expect(await response.json()).toEqual({ csrfToken: "fixture-csrf" }); expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it("rejects CSRF before reading credentials or calling an operation", async () => {
    mocks.protocol.allowsMutation.mockReturnValue(false); expect((await mutate(request("/auth/identity/session", { operation: "password" }))).status).toBe(403);
    expect(mocks.protocol.passwordLogin).not.toHaveBeenCalled();
  });
  it.each(["text/plain", "application/x-www-form-urlencoded"])("rejects %s payloads", async (type) => {
    const response = await mutate(request("/auth/identity/session", { operation: "password" }, { "content-type": type })); expect(response.status).toBe(415); expect(mocks.protocol.passwordLogin).not.toHaveBeenCalled();
  });
  it("bounds chunked input without trusting Content-Length", async () => {
    const response = await mutate(request("/auth/identity/session", { operation: "password", password: "x".repeat(9000) })); expect(response.status).toBe(413); expect(mocks.protocol.passwordLogin).not.toHaveBeenCalled();
  });
  it("does not expose a method or URL proxy", async () => {
    const response = await mutate(request("/auth/identity/session", { operation: "https://evil.example", token: "marker" })); expect(response.status).toBe(400);
    expect(mocks.protocol.passwordLogin).not.toHaveBeenCalled();
  });
  it("passes credentials to the fixed password operation and returns no credentials", async () => {
    const response = await mutate(request("/auth/identity/session", { operation: "password", email: "fixture@example.com", password: "marker" }));
    expect(mocks.protocol.passwordLogin).toHaveBeenCalledWith("fixture@example.com", "marker"); expect(await response.json()).toEqual({ signedIn: true });
  });
  it("never returns arbitrary provider exceptions", async () => {
    mocks.protocol.passwordLogin.mockRejectedValue(new Error("provider-secret-marker"));
    const response = await mutate(request("/auth/identity/session", { operation: "password" })); expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: "unavailable" });
  });
  it("keeps duplicate-email signup indistinguishable from mail sent", async () => {
    mocks.protocol.signup.mockRejectedValue(new IdentityError("invalid"));
    const response = await mutate(request("/auth/identity/session", { operation: "signup" })); expect(response.status).toBe(200); expect(await response.json()).toEqual({ sent: true });
  });
  it("does not hide a disabled signup policy as successful registration", async () => {
    mocks.protocol.signup.mockRejectedValue(new IdentityError("disabled"));
    expect((await mutate(request("/auth/identity/session", { operation: "signup" }))).status).toBe(403);
  });
});

describe("Identity redirects, recovery, and internal identity mapping", () => {
  it("keeps the invite through a failed OAuth callback without reflecting Host", async () => {
    mocks.protocol.finishGoogle.mockRejectedValue(new Error("provider-secret-marker"));
    const response = await callback(request("/auth/callback?error=access_denied", undefined, { host: "evil.example", "x-forwarded-host": "evil.example" }));
    expect(response.headers.get("location")).toBe("/login?next=%2Finvite%2Ffixture&error=oauth"); expect(mocks.protocol.clearSession).toHaveBeenCalled(); expect(mocks.legacy).not.toHaveBeenCalled();
  });
  it("stores Google offline credentials only using the mapped internal UUID", async () => {
    const response = await callback(request("/auth/callback?code=fixture&state=fixture"));
    expect(mocks.mode).toHaveBeenCalledWith("get_media_storage_mode");
    expect(mocks.saveGoogle).toHaveBeenCalledWith({ fixture: "client", rpc: mocks.mode }, "internal-uuid", "provider-refresh-marker");
    expect(response.headers.get("location")).toBe("/invite/fixture"); expect(response.cookies.get(POST_LOGIN_NEXT_COOKIE)?.value).toBe("");
  });
  it("does not save provider tokens until identity synchronization succeeds", async () => {
    mocks.bridge.mockRejectedValue(new Error("db-marker")); const response = await callback(request("/auth/callback?code=fixture&state=fixture"));
    expect(response.headers.get("location")).toContain("error=oauth"); expect(mocks.saveGoogle).not.toHaveBeenCalled(); expect(mocks.protocol.clearSession).toHaveBeenCalled();
  });
  it("clears the partial session on Drive save failure so retry is reachable", async () => {
    mocks.saveGoogle.mockRejectedValue(new Error("token-marker")); const response = await callback(request("/auth/callback?code=fixture&state=fixture"));
    expect(response.headers.get("location")).toContain("error=drive"); expect(mocks.protocol.clearSession).toHaveBeenCalled();
  });
  it("keeps restored Google ciphertext unchanged while the candidate database is explicitly frozen", async () => {
    mocks.mode.mockResolvedValue({ data: "frozen", error: null });
    const response = await callback(request("/auth/callback?code=fixture&state=fixture"));
    expect(mocks.mode).toHaveBeenCalledExactlyOnceWith("get_media_storage_mode");
    expect(mocks.saveGoogle).not.toHaveBeenCalled(); expect(mocks.protocol.clearSession).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toBe("/invite/fixture");
    expect(response.cookies.get(POST_LOGIN_NEXT_COOKIE)?.value).toBe("");
  });
  it.each([null, "supabase", "unknown", {}, ["gcs"]])("fails closed for an unknown candidate mode %j", async (mode) => {
    mocks.mode.mockResolvedValue({ data: mode, error: null });
    const response = await callback(request("/auth/callback?code=fixture&state=fixture"));
    expect(response.headers.get("location")).toBe("/login?next=%2Finvite%2Ffixture&error=drive");
    expect(mocks.saveGoogle).not.toHaveBeenCalled(); expect(mocks.protocol.clearSession).toHaveBeenCalled();
  });
  it("never treats a mode read failure as permission to skip or save credentials", async () => {
    mocks.mode.mockResolvedValue({ data: "frozen", error: { code: "55000", message: "private-marker" } });
    const response = await callback(request("/auth/callback?code=fixture&state=fixture"));
    expect(response.headers.get("location")).toContain("error=drive");
    expect(mocks.saveGoogle).not.toHaveBeenCalled(); expect(mocks.protocol.clearSession).toHaveBeenCalled();
  });
  it("does not read or update credential storage when Google returned no refresh token", async () => {
    mocks.protocol.finishGoogle.mockResolvedValue({ identity: { subject: "external-subject" } });
    const response = await callback(request("/auth/callback?code=fixture&state=fixture"));
    expect(response.headers.get("location")).toBe("/invite/fixture");
    expect(mocks.mode).not.toHaveBeenCalled(); expect(mocks.saveGoogle).not.toHaveBeenCalled();
  });
  it("uses only the invite cookie after same-subject hosted email confirmation", async () => {
    mocks.protocol.continueEmail.mockResolvedValue(true);
    const response = await continuation(request("/auth/identity/continue?next=https://evil.example&mode=resetPassword&oobCode=ignored"));
    expect(response.headers.get("location")).toBe("/invite/fixture"); expect(mocks.protocol.continueEmail).toHaveBeenCalledWith();
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });
  it("returns to login after hosted reset or when another browser lacks a session", async () => {
    mocks.protocol.continueEmail.mockResolvedValue(false);
    const response = await continuation(request("/auth/identity/continue"));
    expect(response.headers.get("location")).toBe("/login?next=%2Finvite%2Ffixture"); expect(response.cookies.has(POST_LOGIN_NEXT_COOKIE)).toBe(false);
  });
  it("does not hide provider outages as successful email confirmation", async () => {
    mocks.protocol.continueEmail.mockRejectedValue(new Error("secret-marker"));
    const response = await continuation(request("/auth/identity/continue")); expect(response.status).toBe(503); expect(await response.text()).not.toContain("secret-marker");
  });
  it("requires same-origin form signout in GCP mode", async () => {
    mocks.protocol.allowsOrigin.mockReturnValue(false); expect((await signout(request("/auth/signout", {}))).status).toBe(403); expect(mocks.protocol.signout).not.toHaveBeenCalled();
  });
  it("does not report successful signout if global revocation failed", async () => {
    mocks.protocol.signout.mockRejectedValue(new Error("provider-marker")); const response = await signout(request("/auth/signout", {}));
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("provider-marker");
  });
});
