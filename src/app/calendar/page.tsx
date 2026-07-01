import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { SOURCE_LABEL, type RecordWithPhotos } from "@/types/database";
import AppHeader from "@/components/AppHeader";
import SourceIcon from "@/components/SourceIcon";
import { Camera } from "lucide-react";

export const dynamic = "force-dynamic";

export const metadata = { title: "カレンダー" };

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;

// "YYYY-MM" を {year, month(1-12)} に。未指定・不正は今月。
function parseYearMonth(ym: string | undefined): { year: number; month: number } {
  const now = new Date();
  if (ym) {
    const m = /^(\d{4})-(\d{1,2})$/.exec(ym);
    if (m) {
      const year = Number(m[1]);
      const month = Number(m[2]);
      if (month >= 1 && month <= 12) return { year, month };
    }
  }
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function ymString(year: number, month: number) {
  return `${year}-${pad(month)}`;
}

function shiftMonth(year: number, month: number, delta: number) {
  const idx = (year * 12 + (month - 1)) + delta;
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
}

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ ym?: string }>;
}) {
  const { ym } = await searchParams;
  const { year, month } = parseYearMonth(ym);

  const firstDay = `${year}-${pad(month)}-01`;
  const lastDate = new Date(year, month, 0).getDate(); // 当月末日
  const lastDay = `${year}-${pad(month)}-${pad(lastDate)}`;

  const supabase = await createClient();
  const { data } = await supabase
    .from("daycare_records")
    .select("*, record_photos(*)")
    .gte("record_date", firstDay)
    .lte("record_date", lastDay)
    .order("record_date", { ascending: true })
    .order("created_at", { ascending: true })
    .returns<RecordWithPhotos[]>();

  const records = data ?? [];

  // 日付(YYYY-MM-DD) -> その日の記録
  const byDate = new Map<string, RecordWithPhotos[]>();
  for (const r of records) {
    const list = byDate.get(r.record_date) ?? [];
    list.push(r);
    byDate.set(r.record_date, list);
  }

  // カレンダーグリッド（前後の空白セルを含む）
  const firstWeekday = new Date(year, month - 1, 1).getDay(); // 0=日
  const cells: (number | null)[] = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= lastDate; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const prev = shiftMonth(year, month, -1);
  const next = shiftMonth(year, month, 1);
  const todayStr = `${new Date().getFullYear()}-${pad(new Date().getMonth() + 1)}-${pad(new Date().getDate())}`;

  return (
    <>
      <AppHeader />
      <main id="main" className="mx-auto max-w-2xl px-4 py-6">
        <div className="mb-4 flex items-center justify-between">
          <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
            ← 一覧へ戻る
          </Link>
        </div>

        <div className="mb-4 flex items-center justify-between">
          <Link
            href={`/calendar?ym=${ymString(prev.year, prev.month)}`}
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-foreground transition hover:bg-surface-muted"
            aria-label="前の月"
          >
            ‹ 前月
          </Link>
          <h1 className="text-lg font-bold text-foreground">
            {year}年{month}月
          </h1>
          <Link
            href={`/calendar?ym=${ymString(next.year, next.month)}`}
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-foreground transition hover:bg-surface-muted"
            aria-label="次の月"
          >
            翌月 ›
          </Link>
        </div>

        {/* 月カレンダー */}
        <div className="grid grid-cols-7 gap-1 text-center">
          {WEEKDAYS.map((w, i) => (
            <div
              key={w}
              className={
                "py-1 text-xs font-medium " +
                (i === 0
                  ? "text-rose-500"
                  : i === 6
                    ? "text-sky-500"
                    : "text-muted-foreground")
              }
            >
              {w}
            </div>
          ))}
          {cells.map((d, i) => {
            if (d === null) return <div key={`empty-${i}`} />;
            const dateStr = `${year}-${pad(month)}-${pad(d)}`;
            const dayRecords = byDate.get(dateStr) ?? [];
            const has = dayRecords.length > 0;
            const isToday = dateStr === todayStr;
            const sources = new Set(dayRecords.map((r) => r.source));
            const cellInner = (
              <div
                className={
                  "flex h-14 flex-col items-center justify-start rounded-lg p-1 text-sm " +
                  (has
                    ? "bg-surface shadow-sm ring-1 ring-border"
                    : "text-muted-foreground") +
                  (isToday ? " ring-2 ring-foreground" : "")
                }
              >
                <span className={has ? "font-semibold text-foreground" : ""}>
                  {d}
                </span>
                {has && (
                  <span className="mt-1 flex items-center gap-0.5">
                    {sources.has("daycare") && (
                      <span className="h-1.5 w-1.5 rounded-full bg-sky-500" />
                    )}
                    {sources.has("home") && (
                      <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                    )}
                  </span>
                )}
              </div>
            );
            return has ? (
              <a key={dateStr} href={`#day-${dateStr}`}>
                {cellInner}
              </a>
            ) : (
              <div key={dateStr}>{cellInner}</div>
            );
          })}
        </div>

        <p className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-sky-500" /> 保育園
          </span>
          <span className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" /> おうち
          </span>
        </p>

        {/* この月の記録（日付ごと） */}
        <section className="mt-8">
          <h2 className="mb-3 text-sm font-medium text-foreground">
            この月の記録（{records.length}件）
          </h2>
          {records.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
              この月の記録はありません。
            </div>
          ) : (
            <ul className="space-y-4">
              {[...byDate.entries()].map(([date, dayRecords]) => (
                <li key={date} id={`day-${date}`} className="scroll-mt-4">
                  <p className="mb-1.5 text-sm font-semibold text-foreground">
                    {new Intl.DateTimeFormat("ja-JP", {
                      month: "long",
                      day: "numeric",
                      weekday: "short",
                    }).format(new Date(date))}
                  </p>
                  <ul className="space-y-2">
                    {dayRecords.map((r) => (
                      <li key={r.id}>
                        <Link
                          href={`/records/${r.id}`}
                          className="flex items-center gap-2 rounded-xl bg-surface px-3 py-2 text-sm shadow-sm ring-1 ring-border transition hover:ring-border"
                        >
                          <span
                            className={
                              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium " +
                              (r.source === "home"
                                ? "bg-amber-100 text-amber-700"
                                : "bg-sky-100 text-sky-700")
                            }
                          >
                            <SourceIcon source={r.source} className="h-3.5 w-3.5" />
                            {SOURCE_LABEL[r.source]}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-foreground">
                            {r.body.replace(/\s+/g, " ").trim() || "（本文なし）"}
                          </span>
                          {(r.record_photos?.length ?? 0) > 0 && (
                            <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                              <Camera className="h-3.5 w-3.5" aria-hidden="true" />
                              {r.record_photos.length}
                            </span>
                          )}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </>
  );
}
