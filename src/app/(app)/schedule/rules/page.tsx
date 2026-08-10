import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { canEdit, getCurrentMembership } from "@/lib/household";
import { EMPTY_SCHEDULE, fetchSchedule } from "@/lib/scheduleQuery";
import { ruleForDate, rolesFor } from "@/lib/schedule";
import { jstTodayISO } from "@/lib/dateRange";
import {
  ASSIGNEE_ROLE_LABEL,
  RECORD_SOURCES,
  SOURCE_EMOJI,
  SOURCE_LABEL,
} from "@/types/database";
import { saveRule } from "@/app/(app)/schedule/actions";

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

  const schedule = householdId
    ? await fetchSchedule(supabase, householdId, today, today)
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
          const who = rule ? (schedule.ruleAssignees[rule.id] ?? {}) : {};
          const roles = rule ? rolesFor(rule.kind!) : [];
          return (
            <li
              key={label}
              className="rounded-2xl bg-surface p-4 shadow-sm ring-1 ring-border"
            >
              <form action={saveRule} className="space-y-3">
                <input type="hidden" name="weekday" value={weekday} />
                <input type="hidden" name="since" value={today} />
                {householdId && (
                  <input type="hidden" name="household_id" value={householdId} />
                )}

                <div className="flex flex-wrap items-center gap-2">
                  <span className="w-8 shrink-0 text-sm font-bold">
                    {label}曜
                  </span>
                  <label className="sr-only" htmlFor={`source-${weekday}`}>
                    {label}曜の種類
                  </label>
                  <select
                    id={`source-${weekday}`}
                    name="source"
                    defaultValue={rule?.kind ?? "none"}
                    disabled={!editable}
                    className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm"
                  >
                    <option value="none">なし</option>
                    {RECORD_SOURCES.map((s) => (
                      <option key={s} value={s}>
                        {SOURCE_EMOJI[s]} {SOURCE_LABEL[s]}
                      </option>
                    ))}
                  </select>
                  <input
                    type="time"
                    name="start_time"
                    aria-label={`${label}曜の開始時刻`}
                    defaultValue={rule?.start_time ?? ""}
                    disabled={!editable}
                    className="w-28 rounded-lg border border-border bg-surface px-2 py-1.5 text-sm tabular-nums"
                  />
                  <span className="text-sm text-muted-foreground">〜</span>
                  <input
                    type="time"
                    name="end_time"
                    aria-label={`${label}曜の終了時刻`}
                    defaultValue={rule?.end_time ?? ""}
                    disabled={!editable}
                    className="w-28 rounded-lg border border-border bg-surface px-2 py-1.5 text-sm tabular-nums"
                  />
                </div>

                {roles.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2 pl-10">
                    {roles.map((role) => (
                      <label key={role} className="flex items-center gap-1.5 text-xs">
                        <span className="text-muted-foreground">
                          {ASSIGNEE_ROLE_LABEL[role]}
                        </span>
                        <select
                          name={`who_${role}`}
                          defaultValue={who[role] ?? ""}
                          disabled={!editable}
                          aria-label={`${label}曜の${ASSIGNEE_ROLE_LABEL[role]}`}
                          className="rounded-lg border border-border bg-surface px-2 py-1 text-xs"
                        >
                          <option value="">未定</option>
                          {members.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                  </div>
                )}

                {editable && (
                  <button
                    type="submit"
                    className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium transition hover:bg-surface-muted"
                  >
                    {label}曜を今日から変える
                  </button>
                )}
              </form>
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
