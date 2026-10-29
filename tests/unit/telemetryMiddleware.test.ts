import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const auth = vi.hoisted(() => ({ getUser: vi.fn() }));
vi.mock("@supabase/ssr", () => ({ createServerClient: () => ({ auth }) }));
import { updateSession } from "@/lib/supabase/middleware";
afterEach(() => vi.unstubAllEnvs());
describe("telemetry retains session boundary", () => {
  it.each(["GET", "POST"])("drops anonymous %s without consuming invite/recovery context", async (method) => {
    vi.stubEnv("GCP_AUTH_ENABLED", "false"); vi.stubEnv("NEXT_PUBLIC_GCP_AUTH_ENABLED", "false"); vi.stubEnv("VERCEL", "");
    auth.getUser.mockResolvedValue({ data: { user: null } });
    const response = await updateSession(new NextRequest("https://example.test/api/vitals", { method }));
    expect(response.status).toBe(204); expect(response.headers.get("location")).toBeNull(); expect(response.headers.get("set-cookie")).toBeNull();
  });
});
