import { describe, expect, it } from "vitest";
import { buildCareSummary, careMemberLabel, type CareRecord } from "@/lib/careSummary";
import { careAssigneeLabel, formatCareSummaryText } from "@/lib/careSummaryText";

const today = "2026-10-27";
const range = { from: "2026-10-21", to: "2026-11-03" };
const schedule = { rules: [], ruleAssignees: {}, skippedDates: new Set<string>() };
const memberNames = new Map([["member-id", careMemberLabel({ display_name: " あき ", email: "aki@example.com" })]]);
function record(id: string, overrides: Partial<CareRecord> = {}): CareRecord {
  return { id, record_date: today, source: "home", status: "done", start_time: null, end_time: null,
    overrides_rule: false, body: id, pet_id: "pet-a", author: "家族", weight_kg: null, created_at: `${today}T08:00:00Z`, ...overrides };
}
const base = { pet: { name: "むぎ", species: "犬" }, range, today, asOf: today, memberNames, latestWeight: null };

describe("引き継ぎシートのコピー", () => {
  it("日付付きの体重・各状態・担当・注意事項を含め、他ペットと対象未設定の記録本文を渡さない", () => {
    const summary = buildCareSummary({ petId: "pet-a", today, range, schedule, records: [
      record("done-id", { body: "朝ごはんを完食\n元気に散歩", weight_kg: 4.2, who: { care: "member-id" } }),
      record("plan-id", { record_date: "2026-10-28", source: "clinic", status: "planned", body: "健診", start_time: "10:00", end_time: "11:00", who: { care: "missing-id" } }),
      record("skipped-id", { status: "skipped", body: "サロンを見送り", weight_kg: 88 }),
      record("past-id", { record_date: "2026-10-22", status: "planned", body: "未完了のお世話", weight_kg: 77 }),
      record("unassigned-id", { pet_id: null, body: "対象未設定の記録本文" }),
      record("other-id", { pet_id: "pet-b", body: "別ペットの記録" }),
      record("future-id", { record_date: "2026-10-30", body: "未来の実施済み記録" }),
    ] });
    const text = formatCareSummaryText({ ...base, summary, latestWeight: { record_date: "2026-10-17", weight_kg: 4.2 } });
    expect(text).toBe(`お世話の引き継ぎ：むぎ（犬）

対象期間：2026/10/21〜2026/11/03
記録・体重は2026/10/27まで。予定は今日以降を表示。
作成日：2026/10/27（日本時間）
最近の体重：4.20 kg
2026/10/17の記録（対象期間より前）

【これまでの記録】1件
実施したこと・日々のようす
2026/10/27 · おうち
朝ごはんを完食
元気に散歩
体重：4.20 kg
みる人：あき · 記入者：家族

【これからの予定】1件
このペットに設定されている予定
2026/10/28 · 病院 · 10:00〜11:00
健診
みる人：確認できないメンバー

【見送った予定】1件
実施済みには含めていません。
2026/10/27 · おうち
サロンを見送り
担当未設定 · 記入者：家族

【過去の未完了予定】1件
保存済みの予定のうち、完了・見送りが記録されていないもの
2026/10/22 · おうち
未完了のお世話
担当未設定 · 記入者：家族

対象ペットが未設定の記録1件は、このシートの記録に含めていません。

mfmf · 入力された記録と予定を整理したシートです。
記載内容は作成時点のものです。渡す相手に必要な情報か確認してください。`);
  });

  it("未設定の世帯予定をペットの予定と分け、空の記録・体重は明示する", () => {
    const summary = buildCareSummary({ petId: "pet-a", today, range, records: [], schedule: {
      ...schedule,
      rules: [{ id: "weekly", household_id: "household-id", weekday: 3, since: today, kind: "daycare", start_time: "09:00", end_time: "18:00", created_by: "member-id", created_at: "", updated_at: "" }],
      ruleAssignees: { weekly: { drop: "member-id", pick: "missing-id" } },
    } });
    const text = formatCareSummaryText({ ...base, pet: { name: "むぎ", species: null }, summary });
    expect(text).toContain("お世話の引き継ぎ：むぎ\n");
    expect(text).toContain("最近の体重：記録なし");
    expect(text).toContain("【これまでの記録】0件\n実施したこと・日々のようす\nこの期間の記録はありません。");
    expect(text).toContain("【これからの予定】0件\nこのペットに設定されている予定\nこの期間に、このペットの予定はありません。");
    expect(text).toContain("【対象ペット未設定の世帯予定】1件\n毎週の予定など、対象ペットが決まっていない予定です。この子の予定とは限りません。\n2026/10/28 · 保育園 · 09:00〜18:00\n毎週の予定ルールから表示\n送り：あき / お迎え：確認できないメンバー");
    expect(text).toContain("この期間に見送った予定はありません。");
    expect(text).not.toContain("過去の未完了予定");
    expect(text).not.toContain("@example.com");
    expect(text).not.toContain("-id");
  });

  it("画面と同じ担当の順序と未設定表示を使う", () => {
    expect(careAssigneeLabel(memberNames, { care: "member-id", pick: "missing-id", drop: "member-id" })).toBe("送り：あき / お迎え：確認できないメンバー / みる人：あき");
    expect(careAssigneeLabel(memberNames)).toBe("担当未設定");
  });
});
