import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ enabled: vi.fn(), createClient: vi.fn() }));
vi.mock("@/lib/identity/config", () => ({ isGcpAuthEnabled: mock.enabled }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mock.createClient }));
import { GET } from "@/app/api/feedback/export/route";
import { feedbackExportRecord } from "@/lib/feedbackExport";

const USER = "11111111-1111-4111-8111-111111111111";
const ID = "22222222-2222-4222-8222-222222222222";
const row = () => ({ id: ID, kind: "bug", severity: "annoying", frequency: "once", created_at: "2026-10-28T16:00:00.000Z", context: { page_path: `/records/${ID}?token=SECRET#PRIVATE` } });
const request = (query = "", headers: Record<string, string> = {}) => new Request(`https://example.test/api/feedback/export${query}`, { headers });
function setup(data: unknown[] = [row()], error: unknown = null, user: { id: string } | null = { id: USER }) {
  const query = {
    select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), is: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data, error }).then(resolve),
  };
  const from = vi.fn(() => query);
  mock.createClient.mockResolvedValue({ auth: { getUser: vi.fn(async () => ({ data: { user }, error: null })) }, from });
  return { query, from };
}
beforeEach(() => { vi.clearAllMocks(); mock.enabled.mockReturnValue(true); });

describe("feedback export privacy", () => {
  it("exports only enums and an opaque stable reference despite malicious free text/context", () => {
    const data = { ...row(), body: "PRIVATE-BODY", title: "PERSON-NAME", reporter: "PERSON-NAME", owner_id: USER,
      household_id: USER, expected: "PRIVATE", actual: "PRIVATE", when_happened: "PRIVATE",
      context: { ...row().context, user_agent: "SECRET", url: "https://private.example/path?sig=SECRET", viewport: "SECRET" } };
    const result = feedbackExportRecord(data);
    expect(result).toEqual({ reference: expect.stringMatching(/^[a-f0-9]{64}$/), kind: "bug", severity: "annoying", frequency: "once", page: "record-detail", date: "2026-10-29" });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|PERSON|SECRET|https|11111111|22222222/);
    expect(result.reference).toBe(feedbackExportRecord({ ...row(), id: ID.toUpperCase() }).reference);
  });
  it.each(["https://private.example/records/new?secret=x", "/invite/private-token", "/settings/account/PRIVATE", "//private.example", "/%72ecords/new", "__proto__", "constructor"])("does not retain unknown or absolute path %s", (page_path) => {
    expect(feedbackExportRecord({ ...row(), context: { page_path } }).page).toBe("other");
  });
  it("maps unknown enum values to safe defaults without string coercion", () => {
    expect(feedbackExportRecord({ ...row(), kind: ["bug"], severity: "PRIVATE", frequency: "SECRET" })).toMatchObject({ kind: "question", severity: null, frequency: null });
  });
  it("rejects a malformed row identity", () => { expect(() => feedbackExportRecord({ ...row(), id: "PRIVATE" })).toThrow(); });
  it.each([["/records/[id]", "record-detail"], ["/share/[token]", "share"], ["/invite/[token]", "invite"], ["/pets/[id]", "pets"], ["/auth/*", "authentication"], ["/api/*", "api"]])("accepts normalized page template %s", (page_path, page) => {
    expect(feedbackExportRecord({ ...row(), context: { page_path } }).page).toBe(page);
  });
  it("does not leak malformed date data", () => { expect(() => feedbackExportRecord({ ...row(), created_at: "PRIVATE" })).toThrow("Invalid feedback date."); });
});

describe("authenticated GCP-only feedback download", () => {
  it("never creates a Supabase-mode client", async () => {
    mock.enabled.mockReturnValue(false);
    expect((await GET(request())).status).toBe(404);
    expect(mock.createClient).not.toHaveBeenCalled();
  });
  it("rejects missing authentication before selecting", async () => {
    const { from } = setup([], null, null);
    expect((await GET(request())).status).toBe(401);
    expect(from).not.toHaveBeenCalled();
  });
  it("uses own-only scope independently of broader household RLS and never selects text", async () => {
    const { query } = setup();
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(query.eq).toHaveBeenCalledWith("owner_id", USER);
    expect(query.select).toHaveBeenCalledWith("id,kind,severity,frequency,context,created_at");
    expect(query.is).toHaveBeenCalledWith("github_issue_number", null);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
    expect((await response.json()).records).toHaveLength(1);
  });
  it("keeps own-only scope on an explicitly selected id", async () => {
    const { query } = setup([]);
    expect((await GET(request(`?id=${ID}`))).status).toBe(200);
    expect(query.eq.mock.calls).toEqual([["owner_id", USER], ["id", ID]]);
  });
  it.each(["?id=bad", `?id=${ID}&id=${ID}`, `?owner_id=${USER}`, "?next=https://private.example"])("rejects invalid query before authentication/database %s", async (query) => {
    expect((await GET(request(query))).status).toBe(400);
    expect(mock.createClient).not.toHaveBeenCalled();
  });
  it.each(["cross-site", "same-site", "unknown", "same-origin, none"])("rejects cross-origin metadata %s", async (site) => {
    expect((await GET(request("", { "sec-fetch-site": site }))).status).toBe(403);
    expect(mock.createClient).not.toHaveBeenCalled();
  });
  it("bounds the response and marks incomplete exports", async () => {
    const { query } = setup(Array.from({ length: 101 }, row));
    const value = await (await GET(request())).json();
    expect(query.limit).toHaveBeenCalledWith(101);
    expect(value.records).toHaveLength(100); expect(value.hasMore).toBe(true);
  });
  it("withholds database/provider exception details", async () => {
    setup([], { message: "PRIVATE" });
    expect(await (await GET(request())).text()).not.toContain("PRIVATE");
    mock.createClient.mockRejectedValue(new Error("SECRET"));
    const response = await GET(request());
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("SECRET");
  });
});
