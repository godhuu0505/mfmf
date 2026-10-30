import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { identityConfig, identityConfigForHost } from "@/lib/identity/config";

beforeEach(() => {
  vi.stubEnv("GCP_AUTH_ENABLED", "true");
  vi.stubEnv("NEXT_PUBLIC_GCP_AUTH_ENABLED", "true");
  vi.stubEnv("GCP_PROJECT_ID", "mfmf-499612");
  vi.stubEnv("IDENTITY_PLATFORM_API_KEY", "synthetic-test-public-api-key");
  vi.stubEnv("GOOGLE_CLIENT_ID", "synthetic.apps.googleusercontent.com");
  vi.stubEnv("GCP_AUTH_ORIGIN", "https://mfmf-candidate-wspqvmhj6q-an.a.run.app");
  vi.stubEnv("GCP_AUTH_WEB_ORIGIN", "https://mfmf.sanba.net");
});
afterEach(() => vi.unstubAllEnvs());
describe("host-bound authentication origins", () => {
  it("keeps the original MCP origin and chooses each registered browser callback host", () => {
    expect(identityConfig().origin).toBe("https://mfmf-candidate-wspqvmhj6q-an.a.run.app");
    expect(identityConfigForHost("mfmf.sanba.net").origin).toBe("https://mfmf.sanba.net");
    expect(identityConfigForHost("mfmf-candidate-wspqvmhj6q-an.a.run.app").origin).toBe(identityConfig().origin);
  });
  it("rejects other apps, malformed hosts and an unconfigured web origin", () => {
    for (const host of [null, "wkwk.sanba.net", "mfmf.sanba.net.evil.test", "mfmf.sanba.net:443"]) expect(() => identityConfigForHost(host)).toThrow();
    vi.stubEnv("GCP_AUTH_WEB_ORIGIN", "https://evil.test");
    expect(() => identityConfigForHost("evil.test")).toThrow();
    expect(() => identityConfigForHost("mfmf.sanba.net")).toThrow();
  });
});
