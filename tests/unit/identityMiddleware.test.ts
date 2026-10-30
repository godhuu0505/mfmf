import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST_LOGIN_NEXT_COOKIE } from "@/lib/nextPath";
import type { IdentityCookies } from "@/lib/identity/protocol";

const mocks = vi.hoisted(() => ({ create: vi.fn(), verified: vi.fn(), recovery: vi.fn(), legacy: vi.fn() }));
vi.mock("@/lib/identity/server", () => ({ createIdentityProtocol: mocks.create }));
vi.mock("@supabase/ssr", () => ({ createServerClient: mocks.legacy }));
import { updateSession } from "@/lib/supabase/middleware";

beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("GCP_AUTH_ENABLED", "true"); vi.stubEnv("NEXT_PUBLIC_GCP_AUTH_ENABLED", "true"); vi.stubEnv("VERCEL", "");
  mocks.verified.mockResolvedValue(null); mocks.recovery.mockReturnValue(false);
  mocks.create.mockReturnValue({ verifiedIdentity: mocks.verified, hasRecovery: mocks.recovery });
});
afterEach(() => { vi.unstubAllEnvs(); });
const request = (path: string, cookie = "") => new NextRequest(`https://0.0.0.0:8080${path}`, { headers: { host: "public.example", cookie } });

describe("Managed identity middleware", () => {
  it.each(["/api/oauth/consent", "/api/oauth/connections"])("returns private JSON401 for expired %s without consuming the browser destination", async path => {
    mocks.create.mockImplementation((cookies: IdentityCookies) => {
      cookies.set("__Host-mfmf-idp-id", "", { path: "/", httpOnly: true, secure: true, sameSite: "lax", maxAge: 0 });
      return { verifiedIdentity: mocks.verified };
    });
    const response = await updateSession(request(path, `${POST_LOGIN_NEXT_COOKIE}=%2Foauth%2Fconsent%2F${"t".repeat(43)}`));
    expect(response.status).toBe(401); expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toContain("no-store"); expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.cookies.has(POST_LOGIN_NEXT_COOKIE)).toBe(false);
    expect(response.cookies.get("__Host-mfmf-idp-id")?.maxAge).toBe(0);
    expect(await response.json()).toEqual({ error: "UNAUTHENTICATED", message: "ログインしてください。" });
    expect(mocks.verified).toHaveBeenCalledOnce();
  });
  it("keeps consent page login redirects while protocol requests never read the browser session", async () => {
    const path = `/oauth/consent/${"t".repeat(43)}`;
    const response = await updateSession(request(path));
    expect(response.status).toBe(307); expect(response.cookies.get(POST_LOGIN_NEXT_COOKIE)?.value).toBe(path);
    mocks.create.mockClear(); mocks.verified.mockClear();
    for (const path of ["/mcp", "/oauth/token", "/oauth/authorize", "/oauth/register", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/mcp"]) expect((await updateSession(request(path))).status).toBe(200);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.verified).not.toHaveBeenCalled();
  });
  it("does not make other API routes anonymous or treat a similarly named route as the browser JSON endpoint", async () => {
    expect((await updateSession(request("/api/oauth/consent/other"))).status).toBe(307);
    expect((await updateSession(request("/api/records"))).status).toBe(307);
  });
  it("protects an invite and ignores old Supabase sessions after cutover", async () => {
    const response = await updateSession(request("/invite/fixture", "sb-mfmf-auth-token=old-session"));
    expect(response.status).toBe(307); expect(response.headers.get("location")).toBe("https://0.0.0.0:8080/login?next=%2Finvite%2Ffixture");
    expect(response.cookies.get(POST_LOGIN_NEXT_COOKIE)?.value).toBe("/invite/fixture"); expect(mocks.legacy).not.toHaveBeenCalled();
  });
  it("propagates refreshed HttpOnly cookies to both the request and every redirect", async () => {
    const req = request("/login?next=%2Finvite%2Ffixture");
    mocks.create.mockImplementation((cookies: IdentityCookies) => {
      cookies.set("__Host-mfmf-idp-id", "new-id", { path: "/", httpOnly: true, secure: true, sameSite: "lax", maxAge: 100 });
      cookies.set("__Host-mfmf-idp-refresh", "new-refresh", { path: "/", httpOnly: true, secure: true, sameSite: "lax", maxAge: 100 });
      return { verifiedIdentity: async () => ({ subject: "verified-subject" }), hasRecovery: () => false };
    });
    const response = await updateSession(req);
    expect(response.headers.get("location")).toBe("https://0.0.0.0:8080/invite/fixture");
    for (const name of ["__Host-mfmf-idp-id", "__Host-mfmf-idp-refresh"]) { expect(req.cookies.get(name)?.value).toBeTruthy(); expect(response.cookies.get(name)?.httpOnly).toBe(true); }
  });
  it("does not downgrade an identity-provider outage to anonymous or Supabase", async () => {
    mocks.verified.mockRejectedValue(new Error("provider-secret-marker")); const response = await updateSession(request("/records/new"));
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("provider-secret-marker"); expect(mocks.legacy).not.toHaveBeenCalled();
  });
  it("requires an authenticated session for the app reset form in managed mode", async () => { expect((await updateSession(request("/reset-password"))).status).toBe(307); });
  it.each(["/auth/identity/continue", "/auth/identity/session", "/forgot-password", "/login"])("permits the public authentication route %s", async (path) => {
    expect((await updateSession(request(path))).status).toBe(200); expect(mocks.legacy).not.toHaveBeenCalled();
  });
  it("keeps an invite destination throughout the recovery form", async () => {
    mocks.verified.mockResolvedValue({ subject: "verified-subject" }); mocks.recovery.mockReturnValue(true);
    const response = await updateSession(request("/reset-password", `${POST_LOGIN_NEXT_COOKIE}=%2Finvite%2Ffixture`));
    expect(response.cookies.has(POST_LOGIN_NEXT_COOKIE)).toBe(false);
  });
  it("consumes the next cookie after the authenticated application is reached", async () => {
    mocks.verified.mockResolvedValue({ subject: "verified-subject" });
    const response = await updateSession(request("/", `${POST_LOGIN_NEXT_COOKIE}=%2Finvite%2Ffixture`));
    expect(response.cookies.get(POST_LOGIN_NEXT_COOKIE)?.value).toBe("");
  });
});
