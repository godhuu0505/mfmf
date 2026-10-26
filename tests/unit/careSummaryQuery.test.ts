import { describe, expect, it } from "vitest";
import { fetchCareSummary } from "@/lib/careSummaryQuery";

// PostgREST のページ境界・途中失敗の契約を検証する。ネットワークや実DBは使わない。
type Response = { data: Record<string, unknown>[] | null; error: { message: string } | null };
const ok = (data: Record<string, unknown>[] = []): Response => ({ data, error: null });
const failure: Response = { data: null, error: { message: "private database details" } };
function fakeClient(pages: Response[], failAt?: "rules" | "members" | "weight" | "skips") {
  const readPages: number[] = [];
  const householdFilters: unknown[] = [];
  const client = {
    from(table: string) {
      let columns = "";
      let offset = 0;
      const query = {
        select(value: string) { columns = value; return query; },
        eq(key: string, value: unknown) { if (key === "household_id") householdFilters.push(value); return query; },
        gte() { return query; }, lte() { return query; }, order() { return query; }, not() { return query; }, limit() { return query; },
        range(start: number) { offset = start; return query; },
        then<TResult1 = Response, TResult2 = never>(onfulfilled?: ((value: Response) => TResult1 | PromiseLike<TResult1>) | null, onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null) {
          let result = ok();
          if (table === "daycare_records" && columns.includes("record_assignees")) {
            readPages.push(offset);
            result = pages[offset / 500] ?? ok();
          } else if (table === "daycare_records" && failAt === "weight") result = failure;
          else if (table === "schedule_rule_skips" && failAt === "skips") result = failure;
          return Promise.resolve(result).then(onfulfilled, onrejected);
        },
      };
      return query;
    },
    rpc(name: string) { return Promise.resolve((name === "schedule_rules_for_range" && failAt === "rules") || (name === "get_household_members" && failAt === "members") ? failure : ok()); },
  };
  return { client: client as unknown as Parameters<typeof fetchCareSummary>[0], readPages, householdFilters };
}
const range = { from: "2026-10-21", to: "2026-11-03" };
const rows = (count: number, prefix = "row") => Array.from({ length: count }, (_, i) => ({
  id: `${prefix}-${i}`, record_date: "2026-10-27", source: "home", status: "done", start_time: null, end_time: null,
  overrides_rule: false, body: "記録", pet_id: "pet-a", author: "家族", weight_kg: null, created_at: "", record_assignees: [],
}));

describe("引き継ぎの読み込み", () => {
  it("1ページ目だけで終わらず後ろの記録も返し、全クエリを現在世帯に絞る", async () => {
    const { client, readPages, householdFilters } = fakeClient([ok(rows(500)), ok(rows(1, "last"))]);
    const result = await fetchCareSummary(client, "household-a", "pet-a", range, "2026-10-27");
    expect(result.records).toHaveLength(501);
    expect(result.records[500].id).toBe("last-0");
    expect(readPages).toEqual([0, 500]);
    expect(householdFilters).toEqual(["household-a", "household-a", "household-a", "household-a"]);
  });
  it("途中のページが失敗したら、先頭ページだけの不完全なシートを返さない", async () => {
    const { client } = fakeClient([ok(rows(500)), failure]);
    await expect(fetchCareSummary(client, "household-a", "pet-a", range, "2026-10-27")).rejects.toThrow("記録を読み込めませんでした");
  });
  it.each(["rules", "members", "weight", "skips"] as const)("%s の失敗を『記録なし』にしない", async (part) => {
    const { client } = fakeClient([ok()], part);
    await expect(fetchCareSummary(client, "household-a", "pet-a", range, "2026-10-27")).rejects.toThrow("予定・担当・体重の読み込みに失敗");
  });
  it("読み込み上限を超えると、件数を黙って切らず期間短縮を案内する", async () => {
    const { client, readPages } = fakeClient(Array.from({ length: 11 }, () => ok(rows(500))));
    await expect(fetchCareSummary(client, "household-a", "pet-a", range, "2026-10-27")).rejects.toThrow("期間を短く");
    expect(readPages).toHaveLength(11);
  });
});
