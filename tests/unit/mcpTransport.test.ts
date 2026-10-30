import { beforeEach, describe, expect, it, vi } from "vitest";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
const mocks = vi.hoisted(() => ({ principal: vi.fn(), repository: vi.fn(), record: vi.fn() }));
vi.mock("@/lib/mcp/oauth", () => ({ requireMcpPrincipal: mocks.principal, mcpUnauthorizedResponse: () => new Response('{"error":"invalid_token"}', { status: 401, headers: { "WWW-Authenticate": 'Bearer scope="mfmf.read"' } }) }));
vi.mock("@/lib/mcp/config", () => ({ mcpConfiguration: () => ({ origin: "https://mfmf.example.test" }) }));
vi.mock("@/lib/mcp/repository", () => ({ createMcpReadRepository: mocks.repository }));
import { handleMcpRequest } from "@/lib/mcp/transport";
const id = "93000000-0000-4000-8000-000000000001";
function request(method = "tools/list", params?: unknown, overrides: { http?: string; headers?: Record<string, string>; body?: unknown; url?: string } = {}) {
  const http = overrides.http ?? "POST";
  return new Request(overrides.url ?? "https://mfmf.example.test/mcp", { method: http, headers: { host: "mfmf.example.test", accept: "application/json, text/event-stream", "content-type": "application/json", "mcp-protocol-version": LATEST_PROTOCOL_VERSION, ...overrides.headers },
    ...(http === "GET" ? {} : { body: JSON.stringify(overrides.body ?? { jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }) }) });
}
beforeEach(() => {
  mocks.principal.mockReset().mockResolvedValue({ subject: "private-subject", userId: "private-user", householdId: "private-household", client: {} });
  mocks.record.mockReset().mockResolvedValue({ id, record_date: "2026-10-29", source: "home", pet_id: null, body: "架空の記録", weight_kg: null });
  mocks.repository.mockReset().mockReturnValue({ pets: vi.fn().mockResolvedValue([]), search: vi.fn().mockResolvedValue([]), record: mocks.record });
});
describe("real SDK stateless MCP transport", () => {
  it("initializes without sessions and lists exactly three read-only OAuth tools", async () => {
    const initialized = await handleMcpRequest(request("initialize", { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "fictional", version: "1" } }));
    expect(initialized.status).toBe(200); expect(initialized.headers.get("mcp-session-id")).toBeNull();
    const response = await handleMcpRequest(request());
    const tools = (await response.json()).result.tools;
    expect(tools.map((tool: {name: string}) => tool.name)).toEqual(["list_pets", "search_records", "get_record"]);
    for (const tool of tools) { expect(tool.annotations.readOnlyHint).toBe(true); expect(tool.inputSchema.additionalProperties).toBe(false); expect(tool.securitySchemes).toEqual([{ type: "oauth2", scopes: ["mfmf.read"] }]); }
    expect(mocks.record).not.toHaveBeenCalled(); expect(response.headers.get("cache-control")).toContain("no-store");
  });
  it("returns a bounded allowlisted record via the real SDK", async () => {
    const response = await handleMcpRequest(request("tools/call", { name: "get_record", arguments: { id } }));
    const serialized = await response.text();
    expect(response.status).toBe(200); expect(JSON.parse(serialized).result.structuredContent.record.id).toBe(id);
    for (const marker of ["private-subject", "private-user", "private-household"]) expect(serialized).not.toContain(marker);
  });
  it.each(["GET", "DELETE", "PUT", "PATCH", "OPTIONS"])("rejects non-POST %s after authenticating", async http => {
    expect((await handleMcpRequest(request("tools/list", undefined, { http }))).status).toBe(405);
    expect(mocks.principal).toHaveBeenCalledOnce(); expect(mocks.record).not.toHaveBeenCalled();
  });
  it("rechecks OAuth on every request and never exposes raw auth errors", async () => {
    expect((await handleMcpRequest(request())).status).toBe(200);
    mocks.principal.mockRejectedValue(new Error("private-credential"));
    const response = await handleMcpRequest(request());
    expect(response.status).toBe(401); expect(response.headers.get("www-authenticate")).toContain("mfmf.read"); expect(await response.text()).not.toContain("private-credential");
  });
  it.each([{ host: "evil.example.test", "x-forwarded-host": "mfmf.example.test" }, { origin: "https://evil.example.test" }, { "mcp-session-id": "guessed-session" }])("rejects mismatched host/origin/session: %j", async headers => {
    expect((await handleMcpRequest(request("tools/list", undefined, { headers: Object.fromEntries(Object.entries(headers).filter(([, value]) => typeof value === "string")) }))).status).toBeGreaterThanOrEqual(400);
  });
  it("accepts internal standalone URL only when public Host is correct", async () => {
    expect((await handleMcpRequest(request("tools/list", undefined, { url: "http://0.0.0.0:8080/mcp" }))).status).toBe(200);
    expect((await handleMcpRequest(request("tools/list", undefined, { url: "https://mfmf.example.test/mcp?token=guess" }))).status).toBe(403);
  });
  it.each([[], { jsonrpc: "2.0", method: "tools/list", extra: true }, "a".repeat(17000)])("rejects batch, unknown envelope keys and oversized bodies", async body => {
    expect((await handleMcpRequest(request("tools/list", undefined, { body }))).status).toBeGreaterThanOrEqual(400);
  });
  it("rejects mutation tool names and user IDs before repository access", async () => {
    for (const params of [{ name: "delete_record", arguments: { id } }, { name: "get_record", arguments: { id, userId: "private-user" } }]) {
      const response = await handleMcpRequest(request("tools/call", params));
      expect((await response.json()).error.code).toBe(-32602);
    }
    expect(mocks.record).not.toHaveBeenCalled();
  });
});
