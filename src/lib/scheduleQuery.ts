// 予定（D34）の読み取り。Server Component から呼ぶ前提で、
// 「その期間のカレンダーを描くのに要るもの」をまとめて 1 回で取る。
// 判定そのもの（どのルールが効くか・どう並べるか）は src/lib/schedule.ts の純粋関数。

import type { createClient } from "@/lib/supabase/server";
import {
  toSource,
  toStatus,
  type AssigneeRole,
  type RecordSource,
  type ScheduleRule,
} from "@/types/database";
import { toHHMM, type SavedRecordInput } from "@/lib/schedule";

type Supabase = Awaited<ReturnType<typeof createClient>>;

export type ScheduleData = {
  records: SavedRecordInput[];
  rules: ScheduleRule[];
  ruleAssignees: Record<string, Partial<Record<AssigneeRole, string>>>;
  skippedDates: Set<string>;
};

export const EMPTY_SCHEDULE: ScheduleData = {
  records: [],
  rules: [],
  ruleAssignees: {},
  skippedDates: new Set(),
};

/**
 * from〜to（YYYY-MM-DD、両端を含む）の予定・記録と、毎週のルールを取る。
 * ルールは期間より前に作られた版も効く。版は消さずに積むので、素朴に世帯ぶん
 * 全部取ると PostgREST の max_rows で新しい版から打ち切られてしまう ——
 * 「その期間に要る版だけ」を RPC（schedule_rules_for_range）で受け取る。
 */
export async function fetchSchedule(
  supabase: Supabase,
  householdId: string,
  from: string,
  to: string,
): Promise<ScheduleData> {
  const [recordsRes, rulesRes, skipsRes] = await Promise.all([
    supabase
      .from("daycare_records")
      .select(
        "id, record_date, source, status, start_time, end_time, overrides_rule, body, record_photos(count), record_assignees(role, user_id)",
      )
      .eq("household_id", householdId)
      .gte("record_date", from)
      .lte("record_date", to)
      .order("record_date", { ascending: true })
      .order("start_time", { ascending: true, nullsFirst: true }),
    supabase.rpc("schedule_rules_for_range", {
      p_household: householdId,
      p_from: from,
      p_to: to,
    }),
    supabase
      .from("schedule_rule_skips")
      .select("on_date")
      .eq("household_id", householdId)
      .gte("on_date", from)
      .lte("on_date", to),
  ]);

  const records: SavedRecordInput[] = (recordsRes.data ?? []).map((r) => {
    const row = r as Record<string, unknown>;
    const photos = row.record_photos as { count: number }[] | null;
    const assignees = (row.record_assignees ?? []) as {
      role: AssigneeRole;
      user_id: string;
    }[];
    const who: Partial<Record<AssigneeRole, string>> = {};
    for (const a of assignees) who[a.role] = a.user_id;
    return {
      id: String(row.id),
      record_date: String(row.record_date),
      source: toSource(row.source),
      status: toStatus(row.status),
      start_time: toHHMM(row.start_time as string | null),
      end_time: toHHMM(row.end_time as string | null),
      overrides_rule: Boolean(row.overrides_rule),
      body: String(row.body ?? ""),
      photoCount: photos?.[0]?.count ?? 0,
      who,
    };
  });

  const ruleRows = (rulesRes.data ?? []) as Record<string, unknown>[];
  const rules: ScheduleRule[] = ruleRows.map((row) => {
    return {
      id: String(row.id),
      household_id: String(row.household_id),
      weekday: Number(row.weekday),
      since: String(row.since),
      kind: row.kind ? (toSource(row.kind) as RecordSource) : null,
      start_time: toHHMM(row.start_time as string | null),
      end_time: toHHMM(row.end_time as string | null),
      created_by: String(row.created_by),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  });

  // 担当は RPC に埋め込めないので、返ってきた版のぶんだけ引く
  const ruleAssignees: ScheduleData["ruleAssignees"] = {};
  if (rules.length > 0) {
    const { data } = await supabase
      .from("schedule_rule_assignees")
      .select("rule_id, role, user_id")
      .in(
        "rule_id",
        rules.map((r) => r.id),
      );
    for (const a of (data ?? []) as {
      rule_id: string;
      role: AssigneeRole;
      user_id: string;
    }[]) {
      (ruleAssignees[a.rule_id] ??= {})[a.role] = a.user_id;
    }
  }

  const skippedDates = new Set(
    (skipsRes.data ?? []).map((s) => String((s as { on_date: string }).on_date)),
  );

  return { records, rules, ruleAssignees, skippedDates };
}
