import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST_LOGIN_NEXT_COOKIE } from "@/lib/nextPath";

const mocks = vi.hoisted(() => ({
  exchange: vi.fn(), signOut: vi.fn(), saveGoogle: vi.fn(), createServer: vi.fn(),
  user: null as null | { id: string },
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: {
  exchangeCodeForSession: mocks.exchange, signOut: mocks.signOut,
} }) }));
vi.mock("@/lib/google/token", () => ({ saveGoogleRefreshToken: mocks.saveGoogle }));
vi.mock("@supabase/ssr", () => ({ createServerClient: mocks.createServer }));

import { GET as callback } from "@/app/auth/callback/route";
import { POST as signout } from "@/app/auth/signout/route";
import { POST as keepNext } from "@/app/auth/next/route";
import { updateSession } from "@/lib/supabase/middleware";

function request(path: string, next?: string, form?: string) {
  return new NextRequest(`https://0.0.0.0:18080${path}`, {
    method: form === undefined ? "GET" : "POST",
    headers: { host: "public.example", "x-forwarded-host": "untrusted.example", "x-forwarded-proto": "https",
      ...(next ? { cookie: `${POST_LOGIN_NEXT_COOKIE}=${encodeURIComponent(next)}` } : {}),
      ...(form === undefined ? {} : { "content-type": "application/x-www-form-urlencoded" }),
    },
    ...(form === undefined ? {} : { body: form }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.user = null;
  mocks.exchange.mockResolvedValue({ data: { session: { user: { id: "fixture-user" } } }, error: null });
  mocks.signOut.mockResolvedValue({ error: null });
  mocks.saveGoogle.mockResolvedValue(undefined);
  mocks.createServer.mockImplementation((_url, _key, options: { cookies: { setAll: (cookies: object[]) => void } }) => {
    options.cookies.setAll([{ name: "refreshed-session", value: "fixture-session", options: { path: "/", httpOnly: true } }]);
    return { auth: { getUser: async () => ({ data: { user: mocks.user } }) } };
  });
});

describe("auth Route Handler redirects behind a proxy", () => {
  it("keeps the invite on OAuth cancellation without reflecting any host", async () => {
    const response = await callback(request("/auth/callback?error=access_denied", "/invite/original"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/login?next=%2Finvite%2Foriginal&error=oauth");
    expect(mocks.exchange).not.toHaveBeenCalled();
  });
  it("keeps the original invite after a recovery exchange error", async () => {
    mocks.exchange.mockResolvedValue({ data: { session: null }, error: { message: "fixture failure" } });
    const response = await callback(request("/auth/callback?code=fixture&next=%2Freset-password", "/invite/original"));
    expect(response.headers.get("location")).toBe("/login?next=%2Finvite%2Foriginal&error=oauth");
  });
  it("retains a Google token-save failure as a relative retry", async () => {
    mocks.exchange.mockResolvedValue({ data: { session: { user: { id: "fixture-user" }, provider_refresh_token: "fixture-refresh" } }, error: null });
    mocks.saveGoogle.mockRejectedValue(new Error("fixture failure"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await callback(request("/auth/callback?code=fixture", "/invite/original"));
      expect(response.headers.get("location")).toBe("/login?next=%2Finvite%2Foriginal&error=drive");
    } finally { log.mockRestore(); }
  });
  it("redirects successful OAuth and removes only a consumed next cookie", async () => {
    const response = await callback(request("/auth/callback?code=fixture", "/invite/original"));
    expect(response.headers.get("location")).toBe("/invite/original");
    expect(response.cookies.get(POST_LOGIN_NEXT_COOKIE)?.value).toBe("");
    const recovery = await callback(request("/auth/callback?code=fixture&next=%2Freset-password", "/invite/original"));
    expect(recovery.headers.get("location")).toBe("/reset-password");
    expect(recovery.cookies.has(POST_LOGIN_NEXT_COOKIE)).toBe(false);
  });
  it("rejects a normalized authority boundary on OAuth success", async () => {
    const response = await callback(request("/auth/callback?code=fixture&next=%2Fa%2F..%2F%2Fevil.example"));
    expect(response.headers.get("location")).toBe("/");
  });
  it("keeps signout 303 semantics and the invite cookie", async () => {
    const response = await signout(request("/auth/signout", undefined, "next=%2Finvite%2Foriginal"));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/login?next=%2Finvite%2Foriginal");
    expect(response.cookies.get(POST_LOGIN_NEXT_COOKIE)?.value).toBe("/invite/original");
    expect(mocks.signOut).toHaveBeenCalledOnce();
  });
  it("allows browser same-origin evidence for next-cookie updates and denies cross-site", async () => {
    const allowed = request("/auth/next", undefined, "next=%2Finvite%2Foriginal");
    allowed.headers.set("origin", "https://public.example");
    allowed.headers.set("sec-fetch-site", "same-origin");
    expect((await keepNext(allowed)).cookies.get(POST_LOGIN_NEXT_COOKIE)?.value).toBe("/invite/original");
    const denied = request("/auth/next", undefined, "next=%2Finvite%2Fattacker");
    denied.headers.set("origin", "https://evil.example");
    denied.headers.set("sec-fetch-site", "cross-site");
    const response = await keepNext(denied);
    expect(response.status).toBe(403);
    expect(response.cookies.has(POST_LOGIN_NEXT_COOKIE)).toBe(false);
  });
});

describe("middleware redirects", () => {
  it("uses the adapter URL and carries refreshed cookies when unauthenticated", async () => {
    const response = await updateSession(request("/invite/original"));
    expect(response.headers.get("location")).toBe("https://0.0.0.0:18080/login?next=%2Finvite%2Foriginal");
    expect(response.cookies.get("refreshed-session")?.value).toBe("fixture-session");
    expect(response.cookies.get(POST_LOGIN_NEXT_COOKIE)?.value).toBe("/invite/original");
  });
  it("keeps an absolute adapter URL and refreshed cookies for authenticated redirects", async () => {
    mocks.user = { id: "fixture-user" };
    const response = await updateSession(request("/login?next=%2Finvite%2Foriginal"));
    expect(response.headers.get("location")).toBe("https://0.0.0.0:18080/invite/original");
    expect(response.cookies.get("refreshed-session")?.value).toBe("fixture-session");
    const normalized = await updateSession(request("/login?next=%2Fa%2F..%2F%2Fevil.example"));
    expect(response.status).toBe(307);
    expect(normalized.headers.get("location")).toBe("https://0.0.0.0:18080/");
  });
});
