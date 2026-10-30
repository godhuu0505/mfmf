import type { buildCareSummary, CareRecord, CareSummaryRange } from "@/lib/careSummary";
import type { ScheduleItem } from "@/lib/schedule";
import { ASSIGNEE_ROLES, ASSIGNEE_ROLE_LABEL, SOURCE_LABEL, type AssigneeRole } from "@/types/database";

export const careDateLabel = (date: string) => date.replace(/-/g, "/");

/** 画面とコピーで担当名を揃える。確認できないIDをそのまま渡さない。 */
export function careAssigneeLabel(memberNames: ReadonlyMap<string, string>, who: Partial<Record<AssigneeRole, string>> = {}): string {
  const labels = ASSIGNEE_ROLES.filter((role) => who[role])
    .map((role) => `${ASSIGNEE_ROLE_LABEL[role]}：${memberNames.get(who[role]!) ?? "確認できないメンバー"}`);
  return labels.length ? labels.join(" / ") : "担当未設定";
}

/** 認可済み画面の集計結果だけを整形する。別の取得・再集計・外部送信はしない。 */
export function formatCareSummaryText(input: {
  pet: { name: string; species: string | null };
  range: CareSummaryRange;
  today: string;
  asOf: string;
  latestWeight: { record_date: string; weight_kg: number } | null;
  summary: ReturnType<typeof buildCareSummary>;
  memberNames: ReadonlyMap<string, string>;
}): string {
  const { pet, range, today, asOf, latestWeight, summary, memberNames } = input;
  const recordText = (row: CareRecord) => [
    `${careDateLabel(row.record_date)} · ${SOURCE_LABEL[row.source]}${row.start_time ? ` · ${row.start_time}〜${row.end_time}` : ""}`,
    row.body || "メモなし",
    ...(row.weight_kg !== null && row.status === "done" ? [`体重：${Number(row.weight_kg).toFixed(2)} kg`] : []),
    `${careAssigneeLabel(memberNames, row.who)}${row.author ? ` · 記入者：${row.author}` : ""}`,
  ].join("\n");
  const planText = (row: ScheduleItem) => [
    `${careDateLabel(row.date)} · ${SOURCE_LABEL[row.source]}${row.start ? ` · ${row.start}〜${row.end}` : " · 時刻未設定"}`,
    ...(row.fromRule ? ["毎週の予定ルールから表示"] : []),
    ...(row.body ? [row.body] : []),
    careAssigneeLabel(memberNames, row.who),
  ].join("\n");
  const section = (title: string, description: string, rows: string[], empty: string) =>
    [`【${title}】${rows.length}件`, description, rows.length ? rows.join("\n\n") : empty].filter(Boolean).join("\n");

  return [
    `お世話の引き継ぎ：${pet.name}${pet.species ? `（${pet.species}）` : ""}`,
    [
      `対象期間：${careDateLabel(range.from)}〜${careDateLabel(range.to)}`,
      `記録・体重は${careDateLabel(asOf)}まで。予定は今日以降を表示。`,
      `作成日：${careDateLabel(today)}（日本時間）`,
      latestWeight
        ? `最近の体重：${Number(latestWeight.weight_kg).toFixed(2)} kg\n${careDateLabel(latestWeight.record_date)}の記録${latestWeight.record_date < range.from ? "（対象期間より前）" : ""}`
        : "最近の体重：記録なし",
    ].join("\n"),
    section("これまでの記録", "実施したこと・日々のようす", summary.done.map(recordText), "この期間の記録はありません。"),
    section("これからの予定", "このペットに設定されている予定", summary.planned.map(planText), "この期間に、このペットの予定はありません。"),
    ...(summary.unassignedPlans.length ? [section("対象ペット未設定の世帯予定", "毎週の予定など、対象ペットが決まっていない予定です。この子の予定とは限りません。", summary.unassignedPlans.map(planText), "")] : []),
    section("見送った予定", "実施済みには含めていません。", summary.skipped.map(recordText), "この期間に見送った予定はありません。"),
    ...(summary.pastPlanned.length ? [section("過去の未完了予定", "保存済みの予定のうち、完了・見送りが記録されていないもの", summary.pastPlanned.map(recordText), "")] : []),
    ...(summary.unassignedRecordCount ? [`対象ペットが未設定の記録${summary.unassignedRecordCount}件は、このシートの記録に含めていません。`] : []),
    "mfmf · 入力された記録と予定を整理したシートです。\n記載内容は作成時点のものです。渡す相手に必要な情報か確認してください。",
  ].join("\n\n");
}
