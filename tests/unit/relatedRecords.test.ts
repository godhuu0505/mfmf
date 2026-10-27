import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/household", () => ({
  getCurrentMembership: vi.fn(),
  householdScopeFilter: (id: string) => `household_id.eq.${id},household_id.is.null`,
}));
import { findRelatedRecords } from "@/lib/relatedRecords";

const membership = { householdId: "11111111-1111-4111-8111-111111111111", role: "viewer" as const };
function fake(options: { denied?: boolean; guest?: boolean; rows?: number; noUser?: boolean } = {}) {
  const events: string[] = [];
  const rows = Array.from({ length: options.rows ?? 2 }, (_, i) => ({
    id: `local-record-${i}`, body: "架空ポチが休んだ。連絡先 fake@example.test 12時", source: "daycare", author: "架空太郎",
    pets: { name: "架空ポチ" }, record_date: "2026-10-27", record_photos: [{ storage_path: "never-send-this-photo" }],
  }));
  const chain = {
    select: vi.fn(function () { return chain; }), eq: vi.fn(function () { return chain; }), or: vi.fn(function () { return chain; }),
    order: vi.fn(function () { return chain; }), gte: vi.fn(function () { return chain; }), lte: vi.fn(function () { return chain; }),
    in: vi.fn(function () { return chain; }), limit: vi.fn(async () => { events.push("read-authorized-candidates"); return { data: rows, error: null }; }),
  };
  const supabase = {
    auth: { getUser: vi.fn(async () => { events.push("auth"); return { data: { user: options.noUser ? null : { id: "authenticated-user", email: "fake@example.test", user_metadata: {} } }, error: null }; }) },
    from: vi.fn(() => chain),
    rpc: vi.fn(async () => { events.push("reserve-budget"); return { data: { allowed: !options.denied }, error: null }; }),
  };
  const rank = vi.fn(async (_q: string, candidates: readonly { id: string }[]) => { events.push("paid-api"); return candidates.map((r) => r.id).reverse(); });
  const dependencies = { supabase: supabase as never, membership: options.guest ? null : membership, rank, enabled: true };
  return { events, supabase, rank, dependencies, chain, rows };
}

describe("authorized opt-in candidate ranking", () => {
  it("does nothing when the feature is off", async () => {
    const h = fake();
    expect((await findRelatedRecords({ query: "休息" }, { ...h.dependencies, enabled: false })).status).toBe("disabled");
    expect(h.events).toEqual([]);
  });
  it.each([{ noUser: true }, { guest: true }])("rejects anonymous users and guest-only callers before reading or sending candidates", async (options) => {
    const h = fake(options);
    expect((await findRelatedRecords({ query: "休息" }, h.dependencies)).status).toBe("unavailable");
    expect(h.supabase.from).not.toHaveBeenCalled(); expect(h.rank).not.toHaveBeenCalled(); expect(h.supabase.rpc).not.toHaveBeenCalled();
  });
  it("reads via the session RLS client, reserves atomically, then calls the paid API", async () => {
    const h = fake();
    const result = await findRelatedRecords({ query: "休息", source: "daycare", from: "2026-10-01" }, h.dependencies);
    expect(result.status).toBe("ranked"); expect(result.records.map((r) => r.id)).toEqual(["local-record-1", "local-record-0"]);
    expect(h.events).toEqual(["auth", "read-authorized-candidates", "reserve-budget", "paid-api"]);
    expect(h.chain.or).toHaveBeenCalledWith(`household_id.eq.${membership.householdId},household_id.is.null`);
    expect(h.chain.limit).toHaveBeenCalledWith(101); expect(h.chain.eq).toHaveBeenCalledWith("status", "done");
    expect(h.supabase.rpc).toHaveBeenCalledWith("reserve_record_ranking", { p_household: membership.householdId });
    expect(h.rank.mock.calls[0][1]).toEqual(h.rows.map((r) => ({ id: r.id, title: "記録元：daycare", content: r.body })));
    expect(JSON.stringify(h.rank.mock.calls[0][1])).not.toContain("never-send-this-photo");
  });
  it("never calls the API if the project/user budget reservation fails", async () => {
    const h = fake({ denied: true });
    expect((await findRelatedRecords({ query: "休息" }, h.dependencies)).status).toBe("limited");
    expect(h.rank).not.toHaveBeenCalled();
  });
  it("sends at most 100 authorized candidates and reports truncation", async () => {
    const h = fake({ rows: 101 });
    const result = await findRelatedRecords({ query: "休息" }, h.dependencies);
    expect(result.status).toBe("ranked"); expect(result.candidateCount).toBe(100); expect(result.truncated).toBe(true);
    expect(h.rank.mock.calls[0][1]).toHaveLength(100);
  });
  it("does not reserve budget or call the API for an empty result", async () => {
    const h = fake({ rows: 0 });
    expect((await findRelatedRecords({ query: "休息" }, h.dependencies)).status).toBe("empty");
    expect(h.supabase.rpc).not.toHaveBeenCalled(); expect(h.rank).not.toHaveBeenCalled();
  });
  it("does not refund failures and rejects unexpected result IDs", async () => {
    const h = fake(); h.rank.mockResolvedValue(["not-authorized-record"]);
    expect((await findRelatedRecords({ query: "休息" }, h.dependencies)).status).toBe("unavailable");
    expect(h.supabase.rpc).toHaveBeenCalledTimes(1);
  });
});
