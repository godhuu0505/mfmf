import type { createClient } from "@/lib/supabase/server";
import type { AssigneeRole, Pet, ScheduleRule } from "@/types/database";
import type { CareRecord, CareSummaryRange } from "@/lib/careSummary";
import { toHHMM } from "@/lib/schedule";

type Supabase = Awaited<ReturnType<typeof createClient>>;
const PAGE_SIZE = 500;
const MAX_RECORDS = 5000;

export class CareSummaryReadError extends Error {}

export async function fetchCarePets(supabase: Supabase, householdId: string): Promise<Pick<Pet, "id" | "name" | "species" | "birthday">[]> {
  const { data, error } = await supabase.from("pets")
    .select("id, name, species, birthday").eq("household_id", householdId)
    .order("created_at").order("id").limit(PAGE_SIZE);
  if (error || data === null) throw new CareSummaryReadError("ペットを読み込めませんでした。時間をおいて再度お試しください。");
  if (data.length === PAGE_SIZE) throw new CareSummaryReadError("ペットの件数が多いため一覧を作成できませんでした。");
  return data;
}

/** RLS に加え現在世帯を明示。全ペットの overrides_rule が必要なのでここではペットで絞らない。 */
export async function fetchCareSummary(supabase: Supabase, householdId: string, petId: string, range: CareSummaryRange, today: string) {
  const records: CareRecord[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await supabase.from("daycare_records")
      .select("id, record_date, source, status, start_time, end_time, overrides_rule, body, pet_id, author, weight_kg, created_at, record_assignees(role, user_id)")
      .eq("household_id", householdId).gte("record_date", range.from).lte("record_date", range.to)
      .order("record_date").order("id").range(offset, offset + PAGE_SIZE - 1);
    if (error || data === null) throw new CareSummaryReadError("記録を読み込めませんでした。時間をおいて再度お試しください。");
    if (records.length + data.length > MAX_RECORDS) throw new CareSummaryReadError("記録が多いため、期間を短くしてもう一度表示してください。");
    for (const row of data) {
      const who: Partial<Record<AssigneeRole, string>> = {};
      for (const assignee of row.record_assignees ?? []) who[assignee.role as AssigneeRole] = assignee.user_id;
      records.push({ ...row, who, start_time: toHHMM(row.start_time), end_time: toHHMM(row.end_time) } as CareRecord);
    }
    if (data.length < PAGE_SIZE) break;
  }
  const asOf = range.to < today ? range.to : today;
  const [rulesRes, skipsRes, membersRes, weightRes] = await Promise.all([
    supabase.rpc("schedule_rules_for_range", { p_household: householdId, p_from: range.from, p_to: range.to }),
    supabase.from("schedule_rule_skips").select("on_date").eq("household_id", householdId).gte("on_date", range.from).lte("on_date", range.to),
    supabase.rpc("get_household_members", { p_household: householdId }),
    supabase.from("daycare_records").select("record_date, weight_kg").eq("household_id", householdId)
      .eq("pet_id", petId).eq("status", "done").not("weight_kg", "is", null).lte("record_date", asOf)
      .order("record_date", { ascending: false }).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1),
  ]);
  if ([rulesRes, skipsRes, membersRes, weightRes].some((r) => r.error || r.data === null)) {
    throw new CareSummaryReadError("予定・担当・体重の読み込みに失敗しました。時間をおいて再度お試しください。");
  }
  const rules = (rulesRes.data ?? []) as ScheduleRule[];
  // 62日分なら通常は数十版。API の上限に達した結果を「全部」として扱わない。
  if (rules.length >= 1000 || (membersRes.data?.length ?? 0) >= 1000) throw new CareSummaryReadError("予定またはメンバーの件数が多いため、シートを作成できませんでした。");
  const ruleAssignees: Record<string, Partial<Record<AssigneeRole, string>>> = {};
  if (rules.length) {
    // 1版につき最大3担当。小さく区切り PostgREST の件数上限を避ける。
    for (let start = 0; start < rules.length; start += 100) {
      const { data, error } = await supabase.from("schedule_rule_assignees")
        .select("rule_id, role, user_id").in("rule_id", rules.slice(start, start + 100).map((r) => r.id));
      if (error || data === null) throw new CareSummaryReadError("毎週の予定の担当を読み込めませんでした。");
      for (const row of data) (ruleAssignees[row.rule_id] ??= {})[row.role as AssigneeRole] = row.user_id;
    }
  }
  return {
    records,
    schedule: { rules, ruleAssignees, skippedDates: new Set<string>((skipsRes.data ?? []).map((r) => r.on_date)) },
    members: (membersRes.data ?? []) as { user_id: string; display_name: string | null; email: string | null }[],
    latestWeight: (weightRes.data?.[0] ?? null) as { record_date: string; weight_kg: number } | null,
    asOf,
  };
}
