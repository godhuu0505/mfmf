"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { Camera, Plus, X } from "lucide-react";

// 月カレンダー + 日タップで開くボトムシート（UC-C01 / D33）。
// 現行のページ内アンカージャンプを置き換える。データはサーバーから
// シリアライズ可能な形で受け取り、この中では取得しない。

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;

export type CalendarDayRecord = {
  id: string;
  source: "home" | "daycare";
  body: string;
  photoCount: number;
};

type Props = {
  year: number;
  month: number;
  /** 月グリッドのセル（null は前後の空白） */
  cells: (number | null)[];
  todayStr: string;
  /** YYYY-MM-DD -> その日の記録（表示順） */
  days: Record<string, CalendarDayRecord[]>;
  /** editor+ のとき、その日の記録追加導線を出す */
  canAdd: boolean;
};

function pad(n: number) {
  return String(n).padStart(2, "0");
}

export default function CalendarMonth({
  year,
  month,
  cells,
  todayStr,
  days,
  canAdd,
}: Props) {
  const [openDate, setOpenDate] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const sheetRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  // シート表示中は Esc で閉じる + 背景スクロールを止める
  useEffect(() => {
    if (!openDate) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const bg = document.querySelectorAll<HTMLElement>("[data-quick-record-bg]");
    bg.forEach((el) => {
      el.inert = true;
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      bg.forEach((el) => {
        el.inert = false;
      });
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openDate]);

  function open(dateStr: string) {
    if (document.activeElement instanceof HTMLElement) {
      triggerRef.current = document.activeElement;
    }
    setOpenDate(dateStr);
    requestAnimationFrame(() =>
      sheetRef.current?.focus({ preventScroll: true }),
    );
  }

  function close() {
    setOpenDate(null);
    requestAnimationFrame(() =>
      triggerRef.current?.focus({ preventScroll: true }),
    );
  }

  function formatDay(dateStr: string) {
    return new Intl.DateTimeFormat("ja-JP", {
      month: "long",
      day: "numeric",
      weekday: "short",
    }).format(new Date(`${dateStr}T00:00:00`));
  }

  const openRecords = openDate ? (days[openDate] ?? []) : [];

  return (
    <>
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
          const dayRecords = days[dateStr] ?? [];
          const has = dayRecords.length > 0;
          const isToday = dateStr === todayStr;
          const sources = new Set(dayRecords.map((r) => r.source));
          return (
            <button
              key={dateStr}
              type="button"
              onClick={() => open(dateStr)}
              aria-haspopup="dialog"
              aria-label={
                `${month}月${d}日` +
                (has ? ` 記録${dayRecords.length}件` : " 記録なし")
              }
              className={
                "flex h-14 flex-col items-center justify-start rounded-lg p-1 text-sm transition hover:bg-surface-muted " +
                (has
                  ? "bg-surface shadow-sm ring-1 ring-border"
                  : "text-muted-foreground") +
                (isToday ? " ring-2 ring-primary" : "")
              }
            >
              <span className={has ? "font-semibold text-foreground" : ""}>
                {d}
              </span>
              {has && (
                <span className="mt-1 flex items-center gap-0.5" aria-hidden="true">
                  {sources.has("daycare") && (
                    <span className="h-1.5 w-1.5 rounded-full bg-sky-500" />
                  )}
                  {sources.has("home") && (
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                  )}
                </span>
              )}
            </button>
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
        <span className="ml-auto">日付をタップで詳細</span>
      </p>

      {mounted &&
        createPortal(
          <>
      {/* 日別シート */}
      <div
        onClick={close}
        aria-hidden="true"
        className={
          "fixed inset-0 z-40 bg-black/40 transition-opacity duration-300 " +
          (openDate ? "opacity-100" : "pointer-events-none opacity-0")
        }
      />
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={openDate ? `${formatDay(openDate)}の記録` : "日別の記録"}
        inert={!openDate}
        tabIndex={-1}
        className={
          "fixed inset-x-0 bottom-0 z-50 max-h-[80vh] overflow-y-auto rounded-t-2xl bg-surface shadow-lg ring-1 ring-border transition-[transform,visibility] duration-300 " +
          (openDate ? "visible translate-y-0" : "invisible translate-y-full")
        }
      >
        <div className="mx-auto max-w-2xl px-4 pt-3 pb-[calc(1rem+env(safe-area-inset-bottom))]">
          <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-muted" />
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-bold text-foreground">
              {openDate ? `${formatDay(openDate)}の記録` : ""}
            </h2>
            <button
              type="button"
              onClick={close}
              aria-label="閉じる"
              className="rounded-full p-1.5 text-muted-foreground transition hover:bg-surface-muted"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>

          {openRecords.length === 0 ? (
            <p className="rounded-xl bg-surface-muted px-3 py-3 text-sm text-muted-foreground">
              この日の記録はありません。
            </p>
          ) : (
            <ul className="space-y-2">
              {openRecords.map((r) => (
                <li key={r.id}>
                  <Link
                    href={`/records/${r.id}`}
                    className="flex items-center gap-2 rounded-xl bg-surface-muted px-3 py-2.5 text-sm transition hover:bg-muted"
                  >
                    <span
                      className={
                        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium " +
                        (r.source === "home"
                          ? "bg-amber-100 text-amber-900"
                          : "bg-sky-100 text-sky-900")
                      }
                    >
                      {r.source === "home" ? "おうち" : "保育園"}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-foreground">
                      {r.body.replace(/\s+/g, " ").trim() || "（本文なし）"}
                    </span>
                    {r.photoCount > 0 && (
                      <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                        <Camera className="h-3.5 w-3.5" aria-hidden="true" />
                        {r.photoCount}
                      </span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          )}

          {canAdd && openDate && (
            <Link
              href={`/records/new?date=${openDate}`}
              className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl border border-border py-2.5 text-sm font-medium text-foreground transition hover:bg-surface-muted"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              この日の記録を追加
            </Link>
          )}
        </div>
      </div>
          </>,
          document.body,
        )}
    </>
  );
}
