import { itemsOnDate, type SavedRecordInput, type ScheduleItem } from "@/lib/schedule";
import type { ScheduleData } from "@/lib/scheduleQuery";

export const CARE_SUMMARY_MAX_DAYS = 62;
export type CareSummaryRange = { from: string; to: string };
export class CareSummaryRangeError extends Error {}
export type CareRecord = SavedRecordInput & {
  author: string;
  weight_kg: number | null;
  created_at: string;
};

export function careMemberLabel(member: { display_name: string | null; email: string | null }): string {
  return member.display_name?.trim() || member.email?.split("@")[0] || "世帯メンバー";
}

export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1900 || year > 9999) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function shiftCareDate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** 不正な期間を別の期間に丸めない。印刷する内容の取り違えを防ぐ。 */
export function careSummaryRange(from: string | undefined, to: string | undefined, today: string): CareSummaryRange {
  const range = { from: from ?? shiftCareDate(today, -6), to: to ?? shiftCareDate(today, 7) };
  if (!isCalendarDate(range.from) || !isCalendarDate(range.to)) {
    throw new CareSummaryRangeError("開始日と終了日を正しい日付で指定してください。");
  }
  if (range.from > range.to) throw new CareSummaryRangeError("終了日は開始日以降にしてください。");
  const days = (Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / 86_400_000 + 1;
  if (days > CARE_SUMMARY_MAX_DAYS) throw new CareSummaryRangeError(`期間は${CARE_SUMMARY_MAX_DAYS}日以内で指定してください。`);
  return range;
}

/** 世帯全体の上書き・見送りを解決してからペットを絞る。先に絞ると毎週の予定が復活する。 */
export function buildCareSummary(input: {
  records: CareRecord[];
  schedule: Pick<ScheduleData, "rules" | "ruleAssignees" | "skippedDates">;
  petId: string;
  range: CareSummaryRange;
  today: string;
}) {
  const { records, schedule, petId, range, today } = input;
  // 呼び出し側が取得範囲を変えても、他期間のデータをレポートに含めない。
  const inRange = records.filter((r) => r.record_date >= range.from && r.record_date <= range.to);
  const petRecords = inRange.filter((r) => r.pet_id === petId);
  const done = petRecords.filter((r) => r.status === "done" && r.record_date <= today)
    .sort((a, b) => b.record_date.localeCompare(a.record_date) || b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
  const skipped = petRecords.filter((r) => r.status === "skipped")
    .sort((a, b) => a.record_date.localeCompare(b.record_date) || a.id.localeCompare(b.id));
  const planned: ScheduleItem[] = [];
  const unassignedPlans: ScheduleItem[] = [];
  for (let date = range.from < today ? today : range.from; date <= range.to; date = shiftCareDate(date, 1)) {
    const items = itemsOnDate({ date, records: inRange, ...schedule });
    for (const item of items) {
      if (item.status !== "planned") continue;
      if (item.petId === petId) planned.push(item);
      // 毎週のルールはペットを持たない。1頭の世帯でも自動で関連付けない。
      else if (item.petId === null) unassignedPlans.push(item);
    }
    if (date === range.to) break;
  }
  return {
    done, planned, skipped, unassignedPlans,
    pastPlanned: petRecords.filter((r) => r.status === "planned" && r.record_date < today),
    unassignedRecordCount: inRange.filter((r) => !r.pet_id && r.status === "done" && r.record_date <= today).length,
  };
}
