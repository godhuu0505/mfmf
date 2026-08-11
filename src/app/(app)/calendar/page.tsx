import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { canEdit, getCurrentMembership } from "@/lib/household";
import ScheduleCalendar, {
  type CalendarItem,
  type CalendarMember,
} from "@/components/ScheduleCalendar";
import { EMPTY_SCHEDULE, fetchSchedule } from "@/lib/scheduleQuery";
import { itemsOnDate } from "@/lib/schedule";
import { jstTodayISO } from "@/lib/dateRange";

export const dynamic = "force-dynamic";

export const metadata = { title: "カレンダー" };

// "YYYY-MM" を {year, month(1-12)} に。未指定・不正は fallback（JST の今月）。
function parseYearMonth(
  ym: string | undefined,
  fallback: { year: number; month: number },
): { year: number; month: number } {
  if (ym) {
    const m = /^(\d{4})-(\d{1,2})$/.exec(ym);
    if (m) {
      const year = Number(m[1]);
      const month = Number(m[2]);
      if (month >= 1 && month <= 12) return { year, month };
    }
  }
  return fallback;
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function ymString(year: number, month: number) {
  return `${year}-${pad(month)}`;
}

function shiftMonth(year: number, month: number, delta: number) {
  const idx = year * 12 + (month - 1) + delta;
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
}

/** iso の n 日後（YYYY-MM-DD）。実行 TZ に依存させない。 */
function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/**
 * YYYY-MM-DD が**実在する日**か。?open= は日別シートの見出し（Intl の format）へ
 * そのまま渡るので、形だけの検査では足りない —— 2026-99-99 のような値を通すと
 * Invalid Date になり、カレンダーごと RangeError で落ちる。
 */
function isRealDate(iso: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return (
    t.getUTCFullYear() === y &&
    t.getUTCMonth() === mo - 1 &&
    t.getUTCDate() === d
  );
}

/** iso を含む週（日曜はじまり）の 7 日。 */
function weekOf(iso: string): string[] {
  const [y, m, d] = iso.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const start = addDays(iso, -dow);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** 表示名が無い人も「誰か」が分かるように、メール名 → 「メンバー」の順で落とす。 */
function memberLabel(row: {
  display_name: string | null;
  email: string | null;
}): string {
  const name = row.display_name?.trim();
  if (name) return name;
  const local = row.email?.split("@")[0]?.trim();
  return local || "メンバー";
}

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{
    ym?: string;
    w?: string;
    view?: string;
    open?: string;
  }>;
}) {
  const { ym, w, view, open } = await searchParams;
  // 月を送っても表示（月／週）は保つ。URL を正にしておかないと、
  // クライアントの状態と出ているものが食い違う
  const viewParam = view === "week" ? "&view=week" : "";
  // 「今日」「今月」は JST 基準（サーバーの実行 TZ が UTC だと、日本の 0:00〜8:59
  // に前日・前月扱いになってしまう）。
  const todayStr = jstTodayISO();
  const [todayYear, todayMonth] = todayStr.split("-").map(Number);
  const { year, month } = parseYearMonth(ym, {
    year: todayYear,
    month: todayMonth,
  });

  const firstDay = `${year}-${pad(month)}-01`;
  const lastDate = new Date(year, month, 0).getDate(); // 当月末日
  const lastDay = `${year}-${pad(month)}-${pad(lastDate)}`;

  const supabase = await createClient();
  const membership = await getCurrentMembership(supabase);
  const householdId = membership?.householdId ?? null;
  const canAdd = membership !== null && canEdit(membership.role);

  // 週表示の起点。?w= があればその日を含む週、無ければ「その月の今日」または
  // その月の 1 日の週（?w= が無いと 9 月の 15 日の週などを一生開けない）
  const weekAnchor = /^\d{4}-\d{2}-\d{2}$/.test(w ?? "")
    ? (w as string)
    : year === todayYear && month === todayMonth
      ? todayStr
      : firstDay;
  const weekDays = weekOf(weekAnchor);
  const weekLabel = `${Number(weekDays[0].slice(5, 7))}/${Number(
    weekDays[0].slice(8),
  )} 〜 ${Number(weekDays[6].slice(5, 7))}/${Number(weekDays[6].slice(8))}`;
  // 週を動かすと、その週の月をそのまま見せる（月表示に戻したときに合う）
  const weekHref = (anchor: string) =>
    `/calendar?ym=${anchor.slice(0, 7)}&w=${anchor}&view=week`;

  // 月グリッドと週表示の両方を賄う範囲でまとめて取る
  const from = weekDays[0] < firstDay ? weekDays[0] : firstDay;
  const to = weekDays[6] > lastDay ? weekDays[6] : lastDay;

  const schedule = householdId
    ? await fetchSchedule(supabase, householdId, from, to)
    : EMPTY_SCHEDULE;

  const { data: memberRows } = householdId
    ? await supabase.rpc("get_household_members", { p_household: householdId })
    : { data: null };
  // ペットが 2 頭以上いる世帯では、どの子の予定かを選べるようにする
  // （選ばないと記録になったときにどの子か分からず、ゲスト共有にも乗らない）
  const { data: petRows, error: petsError } = householdId
    ? await supabase
        .from("pets")
        .select("id, name")
        .eq("household_id", householdId)
        .order("created_at", { ascending: true })
    : { data: null, error: null };
  // 読めないまま「ペットなし」で描くと、2 頭以上いる世帯で「どの子」の選択が
  // 出ず、どの子か付かないまま保存されてしまう
  if (petsError) {
    throw new Error(`ペットの読み込みに失敗しました: ${petsError.message}`);
  }
  const pets = ((petRows ?? []) as { id: string; name: string }[]).map((p) => ({
    id: p.id,
    name: p.name,
  }));
  const members: CalendarMember[] = (
    ((memberRows as unknown) ?? []) as {
      user_id: string;
      display_name: string | null;
      email: string | null;
    }[]
  ).map((m) => {
    const name = memberLabel(m);
    return { id: m.user_id, name, initial: [...name][0] ?? "?" };
  });

  // 月グリッド + 週の 7 日ぶんを、同じ規則（ルール由来を足す）で組み立てる
  const dates = new Set<string>(weekDays);
  for (let d = 1; d <= lastDate; d++)
    dates.add(`${year}-${pad(month)}-${pad(d)}`);
  const itemsByDate: Record<string, CalendarItem[]> = {};
  for (const date of dates) {
    const items = itemsOnDate({
      date,
      records: schedule.records,
      rules: schedule.rules,
      ruleAssignees: schedule.ruleAssignees,
      skippedDates: schedule.skippedDates,
    });
    if (items.length > 0) itemsByDate[date] = items;
  }

  // ?open= は**取得済みの範囲の日だけ**受け付ける。範囲外（例: 8 月を見ている
  // URL に 2027-01-15）を通すと、その日にすでに予定やルール由来の予定があっても
  // itemsByDate に無いので「空の新規」として開き、保存すると二重になる／
  // その日のルールを打ち消してしまう
  const openDate =
    canAdd && open && isRealDate(open) && dates.has(open) ? open : null;

  // カレンダーグリッド（前後の空白セルを含む）
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay(); // 0=日
  const cells: (number | null)[] = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= lastDate; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const prev = shiftMonth(year, month, -1);
  const next = shiftMonth(year, month, 1);
  const isCurrentMonth = year === todayYear && month === todayMonth;
  const monthCount = Object.entries(itemsByDate).filter(
    ([date]) => date >= firstDay && date <= lastDay,
  ).length;

  return (
    <main id="main" className="mx-auto max-w-2xl px-4 py-6">
      <div className="mb-4 flex items-center justify-between">
        <Link
          href={`/calendar?ym=${ymString(prev.year, prev.month)}${viewParam}`}
          className="rounded-lg border border-border px-3 py-1.5 text-sm text-foreground transition hover:bg-surface-muted"
          aria-label="前の月"
        >
          ‹ 前月
        </Link>
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-bold text-foreground">
            {year}年{month}月
          </h1>
          {/* 今月へのショートカット（proto 合意 / notes.md）。今月表示中は出さない。
              素の <a>（フル遷移）にしている: CI 環境でこのリンクだけ Link の
              クライアント遷移が確定しない事象が再現し（最小再現では起きず、
              計装との相互作用が疑い）、月ジャンプは毎回サーバー描画なので
              フル遷移でも体感差がないため、確実に動く方を取る。 */}
          {!isCurrentMonth && (
            <a
              href={`/calendar?ym=${ymString(todayYear, todayMonth)}${viewParam}`}
              className="rounded-full border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition hover:bg-surface-muted"
            >
              今日
            </a>
          )}
        </div>
        <Link
          href={`/calendar?ym=${ymString(next.year, next.month)}${viewParam}`}
          className="rounded-lg border border-border px-3 py-1.5 text-sm text-foreground transition hover:bg-surface-muted"
          aria-label="次の月"
        >
          翌月 ›
        </Link>
      </div>

      <ScheduleCalendar
        year={year}
        month={month}
        cells={cells}
        todayStr={todayStr}
        itemsByDate={itemsByDate}
        weekDays={weekDays}
        members={members}
        pets={pets}
        skippedDates={[...schedule.skippedDates]}
        canEdit={canAdd}
        householdId={householdId}
        initialView={view === "week" ? "week" : "month"}
        // タブバーの「作成」→「予定」から来たときだけ、その日の日別シートを
        // 開いた状態で始める（不正値は無視する）
        initialOpenDate={openDate}
        weekNav={{
          prevHref: weekHref(addDays(weekDays[0], -7)),
          nextHref: weekHref(addDays(weekDays[0], 7)),
          label: weekLabel,
        }}
      />

      <p className="mt-6 text-sm text-muted-foreground">
        {monthCount === 0
          ? "この月の予定・記録はまだありません。日をタップして予定を入れられます。"
          : `この月は ${monthCount} 日ぶんの予定・記録があります。`}
      </p>
      <p className="mt-2 text-sm">
        <Link
          href="/schedule/rules"
          className="text-primary underline underline-offset-4"
        >
          毎週の予定ルールを決める
        </Link>
      </p>
    </main>
  );
}
