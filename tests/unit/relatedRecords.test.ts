import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/household", () => ({
  getCurrentMembership: vi.fn(),
  householdScopeFilter: (id: string) => `household_id.eq.${id},household_id.is.null`,
}));
import { findRelatedRecords } from "@/lib/relatedRecords";

const membership = { householdId: "11111111-1111-4111-8111-111111111111", role: "viewer" as const };
function fake(options: { denied?: boolean; guest?: boolean; rows?: number; noUser?: boolean; currentRows?: number; currentTaggedRows?: number; edited?: boolean; freshUser?: "expired" | "other" } = {}) {
  const events: string[] = [];
  let reads = 0; let authReads = 0; let tagReads = 0;
  const rows = Array.from({ length: options.rows ?? 2 }, (_, i) => ({
    id: `local-record-${i}`, body: "架空ポチが休んだ。連絡先 fake@example.test 12時", source: "daycare", author: "架空太郎",
    pets: { name: "架空ポチ" }, record_date: "2026-10-27", record_photos: [{ storage_path: "never-send-this-photo" }],
  }));
  const chain = {
    select: vi.fn(function () { return chain; }), eq: vi.fn(function () { return chain; }), or: vi.fn(function () { return chain; }),
    order: vi.fn(function () { return chain; }), gte: vi.fn(function () { return chain; }), lte: vi.fn(function () { return chain; }),
    in: vi.fn(function () { return chain; }), limit: vi.fn(async () => {
      reads++;
      events.push(reads === 1 ? "read-authorized-candidates" : "read-current-candidates");
      const current = reads === 1 ? rows : rows.slice(0, options.currentRows ?? 100).map((row) => options.edited ? { ...row, body: "現在の本文", source: "home", record_date: "2026-10-28" } : row);
      return { data: current, error: null };
    }),
  };
  const tags = {
    select: vi.fn(function () { return tags; }), eq: vi.fn(function () { return tags; }), in: vi.fn(function () { return tags; }),
    limit: vi.fn(async () => {
      tagReads++;
      return { data: rows.slice(0, tagReads === 1 ? rows.length : options.currentTaggedRows ?? rows.length).map((row) => ({ record_id: row.id })), error: null };
    }),
  };
  const supabase = {
    auth: { getUser: vi.fn(async () => {
      authReads++; events.push("auth");
      const missing = options.noUser || (authReads > 1 && options.freshUser === "expired");
      const id = authReads > 1 && options.freshUser === "other" ? "different-user" : "authenticated-user";
      return { data: { user: missing ? null : { id, email: "fake@example.test", user_metadata: {} } }, error: null };
    }) },
    from: vi.fn((table: string) => table === "record_tags" ? tags : chain),
    rpc: vi.fn(async () => { events.push("reserve-budget"); return { data: { allowed: !options.denied }, error: null }; }),
  };
  const rank = vi.fn(async (_q: string, candidates: readonly { id: string }[]) => { events.push("paid-api"); return candidates.map((r) => r.id).reverse(); });
  const getMembership = vi.fn(async () => options.guest ? null : membership);
  const dependencies = { supabase: supabase as never, getMembership, rank, enabled: true };
  return { events, supabase, rank, getMembership, dependencies, chain, rows };
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
    expect(h.events).toEqual(["auth", "read-authorized-candidates", "reserve-budget", "paid-api", "auth", "read-current-candidates"]);
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
  it.each(["expired", "other"] as const)("does not return results after a %s session", async (freshUser) => {
    const h = fake({ freshUser });
    expect((await findRelatedRecords({ query: "休息" }, h.dependencies)).status).toBe("unavailable");
    expect(h.rank).toHaveBeenCalledTimes(1);
    expect(h.chain.limit).toHaveBeenCalledTimes(1);
  });
  it("does not return the pre-request body after household membership is revoked", async () => {
    const h = fake(); h.getMembership.mockResolvedValueOnce(membership).mockResolvedValueOnce(null);
    expect((await findRelatedRecords({ query: "休息" }, h.dependencies)).status).toBe("unavailable");
    expect(h.rank).toHaveBeenCalledTimes(1); expect(h.chain.limit).toHaveBeenCalledTimes(1);
  });
  it("omits deleted rows and returns only current body, date and source values", async () => {
    const h = fake({ currentRows: 1, edited: true });
    const result = await findRelatedRecords({ query: "休息" }, h.dependencies);
    expect(result).toMatchObject({ status: "ranked", candidateCount: 1, records: [{ id: "local-record-0", body: "現在の本文", record_date: "2026-10-28", source: "home" }] });
    expect(result.records).toHaveLength(1); expect(JSON.stringify(result.records)).not.toContain("架空ポチ");
  });
  it("returns an empty result if RLS no longer permits any of the ranked rows", async () => {
    const h = fake({ currentRows: 0 });
    expect((await findRelatedRecords({ query: "休息" }, h.dependencies)).status).toBe("empty");
  });
  it("rechecks tag membership after Google and omits records whose tag was removed", async () => {
    const h = fake({ currentTaggedRows: 1 });
    const result = await findRelatedRecords({ query: "休息", tagId: "11111111-1111-4111-8111-111111111111" }, h.dependencies);
    expect(result).toMatchObject({ status: "ranked", candidateCount: 1, records: [{ id: "local-record-0" }] });
    expect(result.records).toHaveLength(1);
  });
  it("returns empty when the selected tag is removed from every candidate during Google", async () => {
    const h = fake({ currentTaggedRows: 0 });
    expect((await findRelatedRecords({ query: "休息", tagId: "11111111-1111-4111-8111-111111111111" }, h.dependencies)).status).toBe("empty");
    expect(h.rank).toHaveBeenCalledTimes(1); expect(h.chain.limit).toHaveBeenCalledTimes(1);
  });
});
