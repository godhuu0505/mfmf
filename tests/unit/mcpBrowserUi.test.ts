import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { consentRedirect, consentSchema, connectionsSchema, loginHref, mcpJson } from "@/components/mcp/browser";

const transactionId = "t".repeat(43);
const csrfToken = "c".repeat(43);
const consent = { transactionId, csrfToken, clientName: "ChatGPT", clientId: "fictional-client", accountLabel: "fictional@example.test", eligibleHouseholds: [{ householdId: "92000000-0000-4000-8000-000000000001", householdName: "架空の家族", role: "viewer" }] };
afterEach(() => vi.unstubAllGlobals());

describe("MCP browser presentation and navigation boundary", () => {
  it("supports the server callbacks without permitting a redirect to an arbitrary origin", () => {
    for (const url of ["https://claude.ai/api/mcp/auth_callback?code=fictional&state=x", "https://chatgpt.com/connector_platform_oauth_redirect?error=access_denied", `https://chatgpt.com/connector/oauth/${"a".repeat(160)}?code=x`]) expect(consentRedirect(url)).toBe(url);
    for (const url of ["https://evil.test/callback", "https://claude.ai.evil.test/api/mcp/auth_callback", "https://user@claude.ai/api/mcp/auth_callback", "https://claude.ai:8443/api/mcp/auth_callback", "https://claude.ai/api/mcp/auth_callback#fragment", "http://claude.ai/api/mcp/auth_callback", "https://chatgpt.com/connector/oauth/", `https://chatgpt.com/connector/oauth/${"a".repeat(161)}`, "https://claude.ai\\@evil.test/api/mcp/auth_callback", "\nhttps://claude.ai/api/mcp/auth_callback"]) expect(consentRedirect(url)).toBeNull();
  });
  it("allows re-login only to a known local screen and preserves an opaque request", () => {
    expect(new URL(loginHref(`/oauth/consent/${transactionId}`), "https://fictional.test").searchParams.get("next")).toBe(`/oauth/consent/${transactionId}`);
    for (const path of ["//evil.test", "https://evil.test", "/oauth/consent/invalid", "/\\evil.test"]) expect(loginHref(path)).toBe("/login?next=%2Fconnections");
  });
  it("rejects malformed/private/oversized DTOs instead of treating failure as an empty list", () => {
    expect(consentSchema.safeParse(consent).success).toBe(true);
    expect(consentSchema.safeParse({ ...consent, subject: "private-subject" }).success).toBe(false);
    expect(consentSchema.safeParse({ ...consent, csrfToken: "bad" }).success).toBe(false);
    expect(consentSchema.safeParse({ ...consent, accountLabel: "fictional\n@example.test" }).success).toBe(false);
    expect(consentSchema.safeParse({ ...consent, eligibleHouseholds: [{ ...consent.eligibleHouseholds[0], role: "guest" }] }).success).toBe(false);
    expect(consentSchema.safeParse({ ...consent, clientName: "x".repeat(201) }).success).toBe(false);
    expect(connectionsSchema.safeParse({ connections: [], csrfToken }).success).toBe(true);
    expect(connectionsSchema.safeParse({ connections: [], csrfToken, token: "must-not-cross" }).success).toBe(false);
  });
});

describe("MCP browser network boundary", () => {
  it("sends browser CSRF with private same-origin JSON and forbids redirect following", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ accepted: true })); vi.stubGlobal("fetch", fetch);
    await expect(mcpJson("/api/oauth/consent", z.strictObject({ accepted: z.literal(true) }), { method: "POST", csrf: csrfToken, body: { transactionId, approved: false } })).resolves.toEqual({ accepted: true });
    expect(fetch).toHaveBeenCalledWith("/api/oauth/consent", expect.objectContaining({ method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", headers: expect.objectContaining({ "x-mfmf-csrf": csrfToken, "Content-Type": "application/json" }), body: JSON.stringify({ transactionId, approved: false }) }));
  });
  it("does not issue a mutation without a valid CSRF token", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(mcpJson("/api/oauth/connections", z.unknown(), { method: "DELETE", csrf: "bad", body: { id: transactionId } })).rejects.toMatchObject({ kind: "forbidden" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([[401, "unauthenticated"], [403, "forbidden"], [404, "expired"], [410, "expired"], [429, "busy"], [503, "unavailable"]])("maps HTTP %s to a static recoverable state without rendering raw server details", async (status, kind) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("raw-private-server-detail", { status: status as number })));
    await expect(mcpJson("/api/oauth/connections", connectionsSchema)).rejects.toMatchObject({ kind, message: kind });
  });
  it("rejects HTML login responses, malformed JSON and excessive bodies", async () => {
    for (const response of [new Response("<html>login</html>", { headers: { "Content-Type": "text/html" } }), new Response("{broken", { headers: { "Content-Type": "application/json" } }), Response.json({ ...consent, clientName: "x".repeat(70_000) })]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
      await expect(mcpJson("/api/oauth/consent", consentSchema)).rejects.toBeInstanceOf(Error);
    }
  });
});
