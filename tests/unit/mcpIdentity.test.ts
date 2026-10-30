import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getUser: vi.fn(), verified: vi.fn(), create: vi.fn(), membership: vi.fn() }));
vi.mock("@/lib/identity/server", () => ({ getIdentityAdminAuth: () => ({ getUser: mocks.getUser }), getVerifiedIdentity: mocks.verified }));
vi.mock("@/lib/gcp/dataClient", () => ({ createGcpDataClient: mocks.create }));
vi.mock("@/lib/mcp/config", () => ({ mcpConfiguration: () => ({ projectId: "mfmf-499612" }) }));
import { getMcpBrowserContext, mcpAccountLabel, mcpHouseholdLabel, verifyMcpIdentity } from "@/lib/mcp/identity";
import { consentSchema } from "@/components/mcp/browser";
const identity = { subject: "fictional-provider-subject", userId: "91000000-0000-4000-8000-000000000001", householdId: "92000000-0000-4000-8000-000000000001" };
let account: { uid: string; email: string; emailVerified: boolean; disabled: boolean; tokensValidAfterTime: string };
beforeEach(() => {
  account = { uid: identity.subject, email: "fictional@example.test", emailVerified: true, disabled: false, tokensValidAfterTime: "fictional-valid-after" };
  mocks.getUser.mockReset().mockImplementation(async () => account);
  mocks.membership.mockReset().mockResolvedValue({ data: { role: "viewer" }, error: null });
  const query = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: mocks.membership };
  mocks.create.mockReset().mockResolvedValue({ client: { from: vi.fn().mockReturnValue(query) }, user: { id: identity.userId } });
});
afterEach(() => vi.unstubAllEnvs());
describe("MCP IdP to internal UUID and household binding", () => {
  it("labels only verified session email and safely falls back for malformed identities", () => {
    expect(mcpAccountLabel({ email: "fictional@example.test", emailVerified: true })).toBe("fictional@example.test");
    for (const email of [undefined, "", "a\n@example.test", "a@b.test\u007f", "a".repeat(321) + "@example.test"]) {
      expect(mcpAccountLabel({ email, emailVerified: true })).toBe("ログイン中のmfmfアカウント");
    }
    expect(mcpAccountLabel({ email: "fictional@example.test", emailVerified: false })).toBe("ログイン中のmfmfアカウント");
  });
  it("normalizes existing unnamed and control-bearing household names for browser DTOs", () => {
    expect(mcpHouseholdLabel("")).toBe("名前未設定の家族");
    expect(mcpHouseholdLabel(null)).toBe("名前未設定の家族");
    expect(mcpHouseholdLabel(" \n架空\t家族\u007f ")).toBe("架空 家族");
    expect(mcpHouseholdLabel("長".repeat(150))).toHaveLength(120);
  });
  it("returns a valid consent DTO for real legacy empty names without promoting guests", async () => {
    mocks.verified.mockResolvedValue({ subject: identity.subject, email: "fictional@example.test", emailVerified: true });
    const query = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue({ data: [
      { household_id: identity.householdId, households: { name: "" }, role: "viewer" },
      { household_id: "92000000-0000-4000-8000-000000000002", households: { name: "\n架空\t家族" }, role: "owner" },
      { household_id: "92000000-0000-4000-8000-000000000003", households: { name: "ゲスト" }, role: "guest:daycare" },
    ], error: null }) };
    mocks.create.mockResolvedValue({ client: { from: vi.fn().mockReturnValue(query) }, user: { id: identity.userId } });
    const context = await getMcpBrowserContext();
    expect(context?.households).toHaveLength(2);
    expect(context?.households[0].householdName).toBe("名前未設定の家族");
    expect(consentSchema.safeParse({ transactionId: "t".repeat(43), clientName: "ChatGPT", clientId: "fictional-client", accountLabel: context?.accountLabel, eligibleHouseholds: context?.households, csrfToken: "c".repeat(43) }).success).toBe(true);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ subject: identity.subject }), { allowCreate: false });
  });
  it.each(["owner", "editor", "viewer"])("permits a current %s via existing RLS without creating a user", async role => {
    vi.stubEnv("SIGNUP_ENABLED", "true"); mocks.membership.mockResolvedValue({ data: { role }, error: null });
    await expect(verifyMcpIdentity(identity, account.tokensValidAfterTime)).resolves.toMatchObject({ validAfter: account.tokensValidAfterTime });
    expect(mocks.create).toHaveBeenCalledWith({ subject: identity.subject, email: account.email, emailVerified: true }, { allowCreate: false });
  });
  it.each(["disabled", "unverified", "revoked", "subject-mismatch", "deleted"])("rejects current IdP denial before database reads: %s", async reason => {
    if (reason === "disabled") account.disabled = true;
    if (reason === "unverified") account.emailVerified = false;
    if (reason === "revoked") account.tokensValidAfterTime = "changed";
    if (reason === "subject-mismatch") account.uid = "other-subject";
    if (reason === "deleted") mocks.getUser.mockRejectedValue({ code: "auth/user-not-found" });
    await expect(verifyMcpIdentity(identity, "fictional-valid-after")).rejects.toMatchObject({ status: 403 });
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each([null, { role: "guest:daycare" }, { role: "unknown" }])("rejects guests, lost membership and unknown roles: %j", async membership => {
    mocks.membership.mockResolvedValue({ data: membership, error: null });
    await expect(verifyMcpIdentity(identity)).rejects.toMatchObject({ status: 403 });
  });
  it("rejects rebound/absent UUID mappings", async () => {
    mocks.create.mockResolvedValue({ client: {}, user: { id: "91000000-0000-4000-8000-000000000002" } });
    await expect(verifyMcpIdentity(identity)).rejects.toMatchObject({ status: 403 });
  });
});
