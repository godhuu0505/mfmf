import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ context: vi.fn(), allows: vi.fn(), consent: vi.fn(), load: vi.fn(), connections: vi.fn(), revoke: vi.fn() }));
vi.mock("@/lib/identity/server", () => ({ getIdentityProtocol: async () => ({ allowsMutation: mocks.allows, csrfToken: () => "fictional-csrf" }) }));
vi.mock("@/lib/mcp/identity", () => ({ getMcpBrowserContext: mocks.context, verifyMcpIdentity: vi.fn() }));
vi.mock("@/lib/mcp/oauth", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/mcp/oauth")>(), consentAuthorization: mocks.consent, loadAuthorization: mocks.load, listConnections: mocks.connections, revokeConnection: mocks.revoke }));
import * as consent from "@/app/api/oauth/consent/route";
import * as connections from "@/app/api/oauth/connections/route";
import { McpHttpError } from "@/lib/mcp/http";
const householdId = "92000000-0000-4000-8000-000000000001";
const userId = "91000000-0000-4000-8000-000000000001";
const transactionId = "t".repeat(43);
function request(body: unknown, method = "POST", headers = { origin: "https://mfmf.example.test", "x-mfmf-csrf": "fictional-csrf" }) {
  return new Request("https://mfmf.example.test/api/oauth/consent", { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}
beforeEach(() => {
  mocks.context.mockReset().mockResolvedValue({ subject: "fictional-subject", userId, accountLabel: "fictional@example.test", households: [{ householdId, householdName: "架空の家族", role: "viewer" }] });
  mocks.allows.mockReset().mockImplementation((request: Request) => request.headers.get("origin") === "https://mfmf.example.test" && request.headers.get("x-mfmf-csrf") === "fictional-csrf");
  mocks.consent.mockReset().mockResolvedValue("https://claude.ai/api/mcp/auth_callback?code=fictional");
  mocks.load.mockReset().mockResolvedValue({ clientName: "Claude", clientId: "fictional-client" });
  mocks.connections.mockReset().mockResolvedValue([]); mocks.revoke.mockReset().mockResolvedValue(undefined);
});
describe("browser OAuth wrappers preserve normal session and CSRF boundary", () => {
  it.each([{ origin: "https://evil.example", "x-mfmf-csrf": "fictional-csrf" }, { origin: "https://mfmf.example.test", "x-mfmf-csrf": "" }])("rejects Origin/CSRF before identity or grant access", async headers => {
    expect((await consent.POST(request({ transactionId, householdId, approved: true }, "POST", headers))).status).toBe(403);
    expect((await connections.DELETE(request({ id: transactionId }, "DELETE", headers))).status).toBe(403);
    expect(mocks.context).not.toHaveBeenCalled(); expect(mocks.consent).not.toHaveBeenCalled(); expect(mocks.revoke).not.toHaveBeenCalled();
  });
  it("rejects a forged household and derives the allowed principal exclusively from the session", async () => {
    expect((await consent.POST(request({ transactionId, householdId: "92000000-0000-4000-8000-000000000002", approved: true }))).status).toBe(403);
    expect(mocks.consent).not.toHaveBeenCalled();
    expect((await consent.POST(request({ transactionId, householdId, approved: true }))).status).toBe(200);
    expect(mocks.consent).toHaveBeenCalledWith(transactionId, { subject: "fictional-subject", userId, householdId }, true);
  });
  it("allows denial with no household selected", async () => {
    expect((await consent.POST(request({ transactionId, approved: false }))).status).toBe(200);
    expect(mocks.consent).toHaveBeenCalledWith(transactionId, { subject: "fictional-subject", userId, householdId: "" }, false);
  });
  it.each(["subject", "userId", "role"])("rejects caller-provided %s rather than trusting it", async field => {
    expect((await consent.POST(request({ transactionId, householdId, approved: true, [field]: "forged" }))).status).toBe(400);
    expect(mocks.consent).not.toHaveBeenCalled();
  });
  it("requires a browser session for consent and revocation", async () => {
    mocks.context.mockResolvedValue(null);
    expect((await consent.POST(request({ transactionId, householdId, approved: true }))).status).toBe(401);
    expect((await connections.DELETE(request({ id: transactionId }, "DELETE"))).status).toBe(401);
    expect(mocks.consent).not.toHaveBeenCalled(); expect(mocks.revoke).not.toHaveBeenCalled();
  });
  it("uses the current session UUID for revoke and preserves ownership denial", async () => {
    mocks.revoke.mockRejectedValue(new McpHttpError("FORBIDDEN", 403, "denied"));
    expect((await connections.DELETE(request({ id: transactionId }, "DELETE"))).status).toBe(403);
    expect(mocks.revoke).toHaveBeenCalledWith(userId, transactionId);
    expect((await connections.DELETE(request({ id: transactionId, userId: "forged" }, "DELETE"))).status).toBe(400);
    expect(mocks.revoke).toHaveBeenCalledOnce();
  });
  it("returns household names for consent and strips household/identity IDs from connection DTOs", async () => {
    const context = await consent.GET(new Request(`https://mfmf.example.test/api/oauth/consent?transactionId=${transactionId}`));
    const body = await context.json();
    expect(body.eligibleHouseholds[0].householdName).toBe("架空の家族");
    expect(body.accountLabel).toBe("fictional@example.test");
    expect(body).not.toHaveProperty("subject"); expect(body).not.toHaveProperty("userId");
    mocks.connections.mockResolvedValue([{ id: transactionId, clientName: "Claude", householdId, createdAt: "2026-10-29T00:00:00Z", expiresAt: "2026-11-28T00:00:00Z" }]);
    const response = await connections.GET(); const serialized = await response.text();
    expect(serialized).toContain("架空の家族"); expect(serialized).not.toContain(householdId); expect(serialized).not.toContain(userId); expect(serialized).not.toContain("fictional@example.test");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
});
