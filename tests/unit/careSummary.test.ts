import { describe, expect, it } from "vitest";
import { buildCareSummary, careMemberLabel, careSummaryRange, isCalendarDate, shiftCareDate, type CareRecord } from "@/lib/careSummary";
import { weekdayOf } from "@/lib/schedule";
import type { ScheduleRule } from "@/types/database";

const today = "2026-10-27";
const range = { from: "2026-10-21", to: "2026-11-03" };
const emptySchedule = { rules: [], ruleAssignees: {}, skippedDates: new Set<string>() };
function record(id: string, overrides: Partial<CareRecord> = {}): CareRecord {
  return { id, record_date: today, source: "home", status: "done", start_time: null, end_time: null,
    overrides_rule: false, body: id, pet_id: "pet-a", author: "家族", weight_kg: null, created_at: `${today}T08:00:00Z`, ...overrides };
}
function rule(date: string): ScheduleRule {
  return { id: "weekly", household_id: "household", weekday: weekdayOf(date), since: "2026-10-01", kind: "daycare",
    start_time: "09:00", end_time: "18:00", created_by: "member", created_at: "", updated_at: "" };
}

describe("引き継ぎの期間", () => {
  it("7日分の記録＋7日先を既定にし、月末・うるう日を正しく扱う", () => {
    expect(careSummaryRange(undefined, undefined, today)).toEqual(range);
    expect(shiftCareDate("2024-03-01", -1)).toBe("2024-02-29");
    expect(isCalendarDate("2024-02-29")).toBe(true);
    for (const date of ["2026-02-29", "2026-04-31", "2026-13-01", "2026-1-01", "", "0000-01-01"]) expect(isCalendarDate(date)).toBe(false);
  });
  it("逆転・存在しない日・長すぎる期間を、黙って別の期間へ変更しない", () => {
    expect(() => careSummaryRange("2026-02-30", today, today)).toThrow("正しい日付");
    expect(() => careSummaryRange("2026-10-28", today, today)).toThrow("終了日");
    expect(() => careSummaryRange("2026-01-01", "2026-03-04", today)).toThrow("62日");
    expect(careSummaryRange("2026-01-01", "2026-03-03", today)).toEqual({ from: "2026-01-01", to: "2026-03-03" });
  });
});

describe("ペット別の引き継ぎ", () => {
  it("表示名のない担当者も識別でき、メールアドレス全体は表示しない", () => {
    expect(careMemberLabel({ display_name: " あき ", email: "a@example.com" })).toBe("あき");
    expect(careMemberLabel({ display_name: null, email: "aki@example.com" })).toBe("aki");
    expect(careMemberLabel({ display_name: " ", email: "haru@example.com" })).toBe("haru");
  });
  it("最大年の末日でも範囲外へ日付を進めない", () => {
    expect(buildCareSummary({ petId: "pet-a", today, range: { from: "9999-12-31", to: "9999-12-31" }, schedule: emptySchedule, records: [] }).planned).toEqual([]);
  });
  it("実施済み・今後の予定・見送りを分離し、他ペット・未来の実施済み記録を混ぜない", () => {
    const result = buildCareSummary({ petId: "pet-a", today, range, schedule: emptySchedule, records: [
      record("done"), record("other", { pet_id: "pet-b", weight_kg: 19 }),
      record("future-done", { record_date: "2026-10-30", weight_kg: 99 }),
      record("plan", { record_date: "2026-10-29", status: "planned" }),
      record("skipped", { status: "skipped" }), record("unassigned", { pet_id: null }),
      record("outside", { record_date: "2026-10-20" }), record("past-plan", { record_date: "2026-10-22", status: "planned" }),
    ] });
    expect(result.done.map((r) => r.id)).toEqual(["done"]);
    expect(result.planned.map((r) => r.id)).toEqual(["plan"]);
    expect(result.skipped.map((r) => r.id)).toEqual(["skipped"]);
    expect(result.pastPlanned.map((r) => r.id)).toEqual(["past-plan"]);
    expect(result.unassignedRecordCount).toBe(1);
  });
  it("毎週の予定は選択ペットへ推測で結び付けず、担当を引き継いだ世帯予定として出す", () => {
    const result = buildCareSummary({ petId: "pet-a", today, range, records: [], schedule: {
      ...emptySchedule, rules: [rule("2026-10-28")], ruleAssignees: { weekly: { drop: "member" } },
    } });
    expect(result.planned).toEqual([]);
    expect(result.unassignedPlans).toMatchObject([{ date: "2026-10-28", fromRule: true, who: { drop: "member" }, petId: null }]);
  });
  it("別ペットで上書きした日・ルールを取り消した日を復活させない", () => {
    const input = { petId: "pet-a", today, range, records: [record("other-override", { pet_id: "pet-b", record_date: "2026-10-28", status: "planned", overrides_rule: true })],
      schedule: { ...emptySchedule, rules: [rule("2026-10-28")] } };
    expect(buildCareSummary(input).unassignedPlans).toEqual([]);
    expect(buildCareSummary({ ...input, records: [], schedule: { ...input.schedule, skippedDates: new Set(["2026-10-28"]) } }).unassignedPlans).toEqual([]);
  });
  it("写真やメモの記録を追加しても、毎週の予定は消えない", () => {
    const result = buildCareSummary({ petId: "pet-a", today, range, records: [record("note", { record_date: "2026-10-28" })],
      schedule: { ...emptySchedule, rules: [rule("2026-10-28")] } });
    expect(result.unassignedPlans).toHaveLength(1);
  });
});
