import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { canEdit, getCurrentMembership } from "@/lib/household";
import { EMPTY_SCHEDULE, fetchSchedule } from "@/lib/scheduleQuery";
import { ruleForDate, weekdayOf } from "@/lib/schedule";
import { jstTodayISO } from "@/lib/dateRange";
import ScheduleRuleRow from "@/components/ScheduleRuleRow";

export const dynamic = "force-dynamic";

export const metadata = { title: "毎週の予定ルール" };

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;

/** today を含む週で、その曜日にあたる日（ルールのプレビュー用）。 */
function dateOfWeekday(today: string, weekday: number): string {
  const [y, m, d] = today.split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  const shifted = new Date(
    Date.UTC(y, m - 1, d + ((weekday - base.getUTCDay() + 7) % 7)),
  );
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

export default async function ScheduleRulesPage() {
  const today = jstTodayISO();
  const supabase = await createClient();
  const membership = await getCurrentMembership(supabase);
  const householdId = membership?.householdId ?? null;
  const editable = membership !== null && canEdit(membership.role);

  // プレビューは「today を含む週」= 最大 6 日先まで見る。today までしか取らないと、
  // 未来から効く版（「これから毎週」で作った先の版）が見えず、そのまま保存すると
  // replace_schedule_rule がその版を消してしまう
  const previewEnd = dateOfWeekday(today, (weekdayOf(today) + 6) % 7);
  const schedule = householdId
    ? await fetchSchedule(supabase, householdId, today, previewEnd)
    : EMPTY_SCHEDULE;

  const { data: memberRows } = householdId
    ? await supabase.rpc("get_household_members", { p_household: householdId })
    : { data: null };
  const members = (
    ((memberRows as unknown) ?? []) as {
      user_id: string;
      display_name: string | null;
      email: string | null;
    }[]
  ).map((m) => ({
    id: m.user_id,
    name: m.display_name?.trim() || m.email?.split("@")[0] || "メンバー",
  }));

  return (
    <main id="main" className="mx-auto max-w-2xl space-y-4 px-4 py-6">
      <Link
        href="/menu"
        className="-ml-1 flex items-center gap-1 text-sm text-muted-foreground transition hover:text-foreground"
      >
        ‹ メニュー
      </Link>
      <div>
        <h1 className="text-base font-bold">毎週の予定ルール</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          いつもの週をここで一度だけ決めます。カレンダーには
          <b className="font-semibold text-foreground">薄く</b>
          自動で入り、違う日だけ上書きすれば大丈夫です。
          変更は<b className="font-semibold text-foreground">今日から</b>
          効き、それ以前の日は前のままです。
        </p>
      </div>

      {!editable && (
        <p className="rounded-xl bg-surface-muted px-3 py-2 text-xs text-muted-foreground">
          閲覧のみの権限のため、ルールは変更できません。
        </p>
      )}

      <ul className="space-y-3">
        {WEEKDAYS.map((label, weekday) => {
          const sample = dateOfWeekday(today, weekday);
          const rule = ruleForDate(schedule.rules, sample);
          return (
            <li
              // 別タブで世帯が切り替わったら、行の下書き（種類・時刻・担当）ごと
              // 作り直す。key を曜日だけにすると前の世帯の入力が残る
              key={`${householdId ?? "none"}-${label}`}
              className="rounded-2xl bg-surface p-4 shadow-sm ring-1 ring-border"
            >
              <ScheduleRuleRow
                weekday={weekday}
                label={label}
                today={today}
                householdId={householdId}
                members={members}
                editable={editable}
                current={
                  rule
                    ? {
                        source: rule.kind!,
                        start: rule.start_time,
                        end: rule.end_time,
                        who: schedule.ruleAssignees[rule.id] ?? {},
                      }
                    : null
                }
              />
            </li>
          );
        })}
      </ul>

      <p className="text-xs text-muted-foreground">
        ルールは<b className="font-semibold text-foreground">版</b>
        で積みます。作り直しても、それ以前の日は前のルールのまま残ります。
      </p>
    </main>
  );
}
