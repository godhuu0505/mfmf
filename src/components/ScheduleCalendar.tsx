"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { createPortal } from "react-dom";
import Link from "next/link";
import { Camera, Check, X } from "lucide-react";
import {
  ASSIGNEE_ROLE_LABEL,
  RECORD_SOURCES,
  SOURCE_EMOJI,
  SOURCE_LABEL,
  type AssigneeRole,
  type RecordSource,
  type RecordStatus,
} from "@/types/database";
import { defaultTimesFor, rolesFor } from "@/lib/schedule";
import {
  clearPlan,
  completePlan,
  reopenPlan,
  restoreRuleForDate,
  savePlan,
  skipPlan,
} from "@/app/(app)/schedule/actions";

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;

/** 週表示の時間割。1 時間 = 48px、ブロックの最小高さ = 22px（proto/schedule で合意）。 */
const ROW = 48;
const MIN_BLOCK_PX = 22;

export type CalendarItem = {
  id: string;
  date: string;
  source: RecordSource;
  status: RecordStatus;
  start: string | null;
  end: string | null;
  body: string;
  photoCount: number;
  who: Partial<Record<AssigneeRole, string>>;
  fromRule: boolean;
};

export type CalendarMember = {
  id: string;
  name: string;
  initial: string;
};

type Props = {
  year: number;
  month: number;
  /** 月グリッドのセル（null は前後の空白） */
  cells: (number | null)[];
  todayStr: string;
  /** YYYY-MM-DD -> その日に並べるもの（予定・記録・ルール由来） */
  itemsByDate: Record<string, CalendarItem[]>;
  /** 週表示に出す 7 日（YYYY-MM-DD） */
  weekDays: string[];
  /** 週表示の前後移動（親が ?w= を差し替える） */
  weekNav?: { prevHref: string; nextHref: string; label: string };
  /** 初期表示（?view=week で開いたときに週から始める） */
  initialView?: "month" | "week";
  members: CalendarMember[];
  /** 世帯のペット。2 頭以上のときだけシートで選ばせる */
  pets?: { id: string; name: string }[];
  /** その日が打ち消されている（曜日ルールを効かせていない） */
  skippedDates: string[];
  canEdit: boolean;
  householdId: string | null;
};

const COLOR: Record<
  RecordSource,
  { soft: string; solid: string; ring: string; dot: string }
> = {
  daycare: {
    soft: "bg-sky-50 text-sky-900 border-sky-500 dark:bg-sky-950 dark:text-sky-100",
    solid: "bg-sky-700 text-white",
    ring: "border-sky-500",
    dot: "bg-sky-500",
  },
  home: {
    soft: "bg-amber-50 text-amber-900 border-amber-500 dark:bg-amber-950 dark:text-amber-100",
    solid: "bg-amber-700 text-white",
    ring: "border-amber-500",
    dot: "bg-amber-500",
  },
  clinic: {
    soft: "bg-violet-50 text-violet-900 border-violet-500 dark:bg-violet-950 dark:text-violet-100",
    solid: "bg-violet-700 text-white",
    ring: "border-violet-500",
    dot: "bg-violet-500",
  },
  salon: {
    soft: "bg-emerald-50 text-emerald-900 border-emerald-500 dark:bg-emerald-950 dark:text-emerald-100",
    solid: "bg-emerald-700 text-white",
    ring: "border-emerald-500",
    dot: "bg-emerald-500",
  },
  other: {
    soft: "bg-slate-50 text-slate-900 border-slate-500 dark:bg-slate-900 dark:text-slate-100",
    solid: "bg-slate-700 text-white",
    ring: "border-slate-500",
    dot: "bg-slate-500",
  },
};

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function minutesOf(v: string | null): number {
  if (!v) return 0;
  const [h, m] = v.split(":").map(Number);
  return h * 60 + m;
}

function formatDay(dateStr: string) {
  return new Intl.DateTimeFormat("ja-JP", {
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(new Date(`${dateStr}T00:00:00`));
}

/** 月セルの読み上げ。件数でまとめる（1 日に何件もあると読み切れない）。 */
function summaryOf(list: CalendarItem[]): string {
  if (list.length === 0) return "予定なし";
  const n = (s: RecordStatus) => list.filter((x) => x.status === s).length;
  return (
    [
      n("planned") > 0 ? `予定${n("planned")}件` : "",
      n("done") > 0 ? `記録${n("done")}件` : "",
      n("skipped") > 0 ? `見送り${n("skipped")}件` : "",
    ]
      .filter(Boolean)
      .join("、") || "予定なし"
  );
}

function statusLabel(status: RecordStatus, fromRule: boolean) {
  if (status === "done") return "記録ずみ";
  if (status === "skipped") return "見送り";
  return fromRule ? "毎週の予定" : "予定";
}

type Draft = {
  source: RecordSource;
  start: string;
  end: string;
  who: Partial<Record<AssigneeRole, string>>;
  body: string;
  /** 時刻を手で触ったか。触るまでは種類の既定に追従する */
  timeDirty: boolean;
};

/**
 * 送信ボタン。Server Action の実行中は全部の submit を塞ぐ ——
 * 1 日に複数の予定を持てる設計なので、二重送信は DB 側の一意制約に当たらず
 * そのまま 2 件になってしまう。
 */
function SubmitButton({
  children,
  className,
  formAction,
}: {
  children: React.ReactNode;
  className: string;
  formAction?: (formData: FormData) => void | Promise<void>;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      formAction={formAction}
      disabled={pending}
      className={className + " disabled:opacity-50"}
    >
      {children}
    </button>
  );
}

function draftOf(item: CalendarItem | null): Draft {
  if (!item) {
    // 新しく入れる予定だけ、種類の既定時間から始める
    const t = defaultTimesFor("daycare");
    return {
      source: "daycare",
      start: t.start,
      end: t.end,
      who: {},
      body: "",
      timeDirty: false,
    };
  }
  // 保存済みの行は持っている値のまま。時刻なしの記録に既定を入れると、
  // ひとことを直しただけで 09:00〜18:00 の予定に化ける
  return {
    source: item.source,
    start: item.start ?? "",
    end: item.end ?? "",
    who: { ...item.who },
    body: item.body,
    timeDirty: true,
  };
}

export default function ScheduleCalendar({
  year,
  month,
  cells,
  todayStr,
  itemsByDate,
  weekDays,
  members,
  pets = [],
  skippedDates,
  canEdit,
  householdId,
  weekNav,
  initialView = "month",
}: Props) {
  const [view, setView] = useState<"month" | "week">(initialView);
  const [openDate, setOpenDate] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(() => draftOf(null));
  /** 開いた時点の下書き。閉じるときに「変えたかどうか」を見る */
  const [openDraft, setOpenDraft] = useState<Draft>(() => draftOf(null));
  const [confirmClose, setConfirmClose] = useState(false);
  /** 確認のあとに開く行（この日のほかの記録・予定から選んだもの） */
  const [pendingSwitch, setPendingSwitch] = useState<string | null>(null);
  /** 「もう 1 件足す」で開いた下書き（その日のルールを隠さない） */
  const [additional, setAdditional] = useState(false);
  /** 新しく作る行の id。押し直しても同じ行に上書きされる（記録が 2 件にならない） */
  const [draftId, setDraftId] = useState<string>("");
  const [mounted, setMounted] = useState(false);
  const [pending, setPending] = useState(false);
  useEffect(() => setMounted(true), []);
  const sheetRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  const skipped = useMemo(() => new Set(skippedDates), [skippedDates]);

  // 別タブで世帯を切り替えると props だけが差し替わる。開いたままにすると、
  // 前の世帯の下書きに新しい世帯の household_id が付いて保存されてしまう
  useEffect(() => {
    setOpenDate(null);
    setOpenId(null);
    setConfirmClose(false);
    setPendingSwitch(null);
    setAdditional(false);
    setDraftId(crypto.randomUUID());
  }, [householdId]);

  // Esc のハンドラは openDate だけを見て張り替わるので、素で requestClose を
  // 掴むと「開いた時点の下書き」で判定してしまう。最新の実装を ref で渡す
  const requestCloseRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!openDate) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const bg = document.querySelectorAll<HTMLElement>("[data-quick-record-bg]");
    bg.forEach((el) => {
      el.inert = true;
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestCloseRef.current();
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

  const openItems = openDate ? (itemsByDate[openDate] ?? []) : [];
  // 開くのは「その日の予定」。記録しかない日は null = これから入れる予定の下書きに
  // する（済んだ記録を予定として開くと、書き換えるつもりのない記録に手が入り、
  // overrides_rule が立って毎週のルールまで隠れてしまう）。
  // 下の一覧から明示的に選んだときだけ、その行を開く。
  // additional のときは何も開かない。ここで予定へ落ちると、「もう 1 件足す」の
  // 下書きに既存の予定の id が戻り、足したつもりが書き換えになる
  const openItem = additional
    ? null
    : ((openId ? (openItems.find((x) => x.id === openId) ?? null) : null) ??
      openItems.find((x) => x.status === "planned") ??
      null);

  function open(dateStr: string, id?: string) {
    if (document.activeElement instanceof HTMLElement) {
      triggerRef.current = document.activeElement;
    }
    const list = itemsByDate[dateStr] ?? [];
    const item =
      (id ? (list.find((x) => x.id === id) ?? null) : null) ??
      list.find((x) => x.status === "planned") ??
      null;
    const next = draftOf(item);
    setOpenDate(dateStr);
    setOpenId(item?.id ?? null);
    setDraft(next);
    setOpenDraft(next);
    setConfirmClose(false);
    setAdditional(false);
    setDraftId(crypto.randomUUID());
    requestAnimationFrame(() =>
      sheetRef.current?.focus({ preventScroll: true }),
    );
  }

  /** 開いた時点から中身が変わっているか（本番の記録フォームと同じ判定の考え方）。 */
  function dirty() {
    if (!canEdit) return false;
    return (
      draft.source !== openDraft.source ||
      draft.start !== openDraft.start ||
      draft.end !== openDraft.end ||
      draft.body !== openDraft.body ||
      JSON.stringify(draft.who) !== JSON.stringify(openDraft.who)
    );
  }

  /** ✕ / 背景 / Esc から呼ぶ。書きかけがあれば確認をはさむ。 */
  function requestClose() {
    if (dirty()) {
      setConfirmClose(true);
      requestAnimationFrame(() =>
        confirmRef.current?.focus({ preventScroll: true }),
      );
      return;
    }
    close();
  }

  /** 一覧の行へ切り替える（開いている日はそのまま）。 */
  function switchTo(item: CalendarItem) {
    setOpenId(item.id);
    const next = draftOf(item);
    setDraft(next);
    setOpenDraft(next);
    setConfirmClose(false);
    setPendingSwitch(null);
    setAdditional(false);
    setDraftId(crypto.randomUUID());
  }

  requestCloseRef.current = requestClose;

  function close() {
    setConfirmClose(false);
    setPendingSwitch(null);
    setOpenDate(null);
    setOpenId(null);
    setAdditional(false);
    requestAnimationFrame(() =>
      triggerRef.current?.focus({ preventScroll: true }),
    );
  }

  function pickType(source: RecordSource) {
    setDraft((d) => {
      const t = defaultTimesFor(source);
      // 種類に無い役割の担当は落とす（保育園 → おうちで「送り」が残らないように）
      const keep: Partial<Record<AssigneeRole, string>> = {};
      for (const role of rolesFor(source))
        if (d.who[role]) keep[role] = d.who[role];
      return {
        ...d,
        source,
        who: keep,
        start: d.timeDirty ? d.start : t.start,
        end: d.timeDirty ? d.end : t.end,
      };
    });
  }

  function toggleWho(role: AssigneeRole, memberId: string) {
    setDraft((d) => ({
      ...d,
      who: {
        ...d.who,
        [role]: d.who[role] === memberId ? undefined : memberId,
      },
    }));
  }

  /**
   * Server Action を実行してからシートを閉じる。
   * 送信と同時に閉じると、実行中にフォームごと外れてしまう。また、ルール由来の
   * 予定は完了・見送りで実体になって id が変わるため、開いたままだと「新規の
   * 下書き」に見えてしまう —— 終わったら閉じるのがいちばん素直。
   */
  function submit(fn: (formData: FormData) => Promise<void>) {
    return async (formData: FormData) => {
      await fn(formData);
      close();
    };
  }

  async function run(fn: () => Promise<void>) {
    setPending(true);
    try {
      await fn();
      close();
    } finally {
      setPending(false);
    }
  }

  const memberOf = (id: string | undefined) =>
    id ? members.find((m) => m.id === id) : undefined;

  // ── 月表示のチップ ──
  function chip(item: CalendarItem) {
    const c = COLOR[item.source];
    if (item.status === "skipped") {
      return (
        <span
          key={item.id}
          className="flex items-center gap-1 rounded px-0.5 text-[10px] text-muted-foreground line-through"
        >
          <span className="h-2 w-2 shrink-0 rounded-full bg-muted" />
          <span className="truncate">{SOURCE_LABEL[item.source]}</span>
        </span>
      );
    }
    return (
      <span
        key={item.id}
        className="flex items-center gap-1 rounded px-0.5 text-[10px]"
      >
        <span
          className={
            "h-2 w-2 shrink-0 rounded-full " +
            (item.status === "done" ? c.dot : `border-[1.5px] ${c.ring}`) +
            (item.fromRule ? " opacity-50" : "")
          }
        />
        {item.start && (
          <span className="hidden shrink-0 tabular-nums text-muted-foreground sm:inline">
            {item.start}
          </span>
        )}
        <span className="truncate">{SOURCE_LABEL[item.source]}</span>
        {item.photoCount > 0 && (
          <Camera
            className="h-2.5 w-2.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        )}
      </span>
    );
  }

  // ── 週表示（時間割）の範囲。その週の予定に合わせて広げる ──
  const [hStart, hEnd] = useMemo(() => {
    let s = 7 * 60;
    let e = 21 * 60;
    for (const d of weekDays) {
      for (const x of itemsByDate[d] ?? []) {
        if (x.status === "skipped" || !x.start || !x.end) continue;
        s = Math.min(s, Math.floor(minutesOf(x.start) / 60) * 60);
        e = Math.max(e, Math.ceil(minutesOf(x.end) / 60) * 60);
      }
    }
    return [Math.max(0, s / 60), Math.min(24, Math.max(e / 60, s / 60 + 1))];
  }, [weekDays, itemsByDate]);

  const gridH = (hEnd - hStart) * ROW;

  /** ブロックが画面上で占める位置。重なり判定もこの位置で行う。 */
  function geom(x: CalendarItem) {
    const s0 = Math.max(minutesOf(x.start), hStart * 60);
    const e0 = Math.min(minutesOf(x.end), hEnd * 60);
    const h = Math.min(gridH, Math.max(MIN_BLOCK_PX, ((e0 - s0) / 60) * ROW));
    const top = Math.max(
      0,
      Math.min(((s0 - hStart * 60) / 60) * ROW, gridH - h),
    );
    return { top, h, bottom: top + h };
  }

  function layout(list: CalendarItem[]) {
    const sorted = list
      .map((x) => ({ x, g: geom(x) }))
      .sort((a, b) => a.g.top - b.g.top || a.g.bottom - b.g.bottom);
    const out: {
      x: CalendarItem;
      g: ReturnType<typeof geom>;
      col: number;
      total: number;
    }[] = [];
    let cluster: typeof sorted = [];
    let clusterEnd = -1;
    const flush = () => {
      if (cluster.length === 0) return;
      const colEnds: number[] = [];
      const placed: {
        x: CalendarItem;
        g: ReturnType<typeof geom>;
        col: number;
      }[] = [];
      for (const q of cluster) {
        let c = colEnds.findIndex((end) => q.g.top >= end);
        if (c === -1) {
          c = colEnds.length;
          colEnds.push(0);
        }
        colEnds[c] = q.g.bottom;
        placed.push({ ...q, col: c });
      }
      for (const q of placed) out.push({ ...q, total: colEnds.length });
      cluster = [];
      clusterEnd = -1;
    };
    for (const q of sorted) {
      if (cluster.length > 0 && q.g.top >= clusterEnd) flush();
      cluster.push(q);
      clusterEnd = Math.max(clusterEnd, q.g.bottom);
    }
    flush();
    return out;
  }

  const roles = rolesFor(draft.source);
  const readOnly = !canEdit;

  return (
    <>
      {/* 月 / 週の切替（タブは増やさない。カレンダーの中で切り替える） */}
      <div
        role="tablist"
        aria-label="カレンダーの表示"
        className="mb-3 grid grid-cols-2 gap-1 rounded-xl bg-surface-muted p-1 text-sm"
      >
        {(["month", "week"] as const).map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={view === v}
            onClick={() => setView(v)}
            className={
              "rounded-lg py-1.5 font-medium transition " +
              (view === v
                ? "bg-surface text-foreground shadow-sm"
                : "text-muted-foreground")
            }
          >
            {v === "month" ? "月" : "週"}
          </button>
        ))}
      </div>

      {view === "month" ? (
        <div className="grid grid-cols-7 overflow-hidden rounded-xl border-l border-t border-border text-center">
          {WEEKDAYS.map((w, i) => (
            <div
              key={w}
              className={
                "border-b border-r border-border py-1 text-xs font-medium " +
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
            if (d === null) {
              return (
                <div
                  key={`empty-${i}`}
                  className="min-h-24 border-b border-r border-border"
                />
              );
            }
            const dateStr = `${year}-${pad(month)}-${pad(d)}`;
            const list = itemsByDate[dateStr] ?? [];
            const shown = list.slice(0, 2);
            const rest = list.length - shown.length;
            const isToday = dateStr === todayStr;
            return (
              <button
                key={dateStr}
                type="button"
                data-day={dateStr}
                onClick={() => open(dateStr)}
                aria-haspopup="dialog"
                aria-label={`${month}月${d}日 ${summaryOf(list)}`}
                className="flex min-h-24 flex-col items-stretch gap-0.5 border-b border-r border-border p-1 text-left transition hover:bg-surface-muted"
              >
                <span
                  className={
                    "mx-auto mb-0.5 flex h-6 w-6 items-center justify-center rounded-full text-xs " +
                    (isToday
                      ? "bg-primary font-bold text-primary-foreground"
                      : "text-muted-foreground")
                  }
                >
                  {d}
                </span>
                {shown.map((x) => chip(x))}
                {rest > 0 && (
                  <span className="px-0.5 text-[10px] text-muted-foreground">
                    他 {rest} 件
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ) : (
        <div>
          {weekNav && (
            <div className="mb-2 flex items-center justify-between">
              <Link
                href={weekNav.prevHref}
                aria-label="前の週"
                className="rounded-lg border border-border px-3 py-1.5 text-sm transition hover:bg-surface-muted"
              >
                ‹ 前週
              </Link>
              <p className="text-sm font-medium tabular-nums">
                {weekNav.label}
              </p>
              <Link
                href={weekNav.nextHref}
                aria-label="次の週"
                className="rounded-lg border border-border px-3 py-1.5 text-sm transition hover:bg-surface-muted"
              >
                翌週 ›
              </Link>
            </div>
          )}
          <div className="overflow-x-auto">
            <div className="min-w-[44rem]">
              <div className="grid grid-cols-[3rem_repeat(7,1fr)] border-b border-border">
                <div />
                {weekDays.map((ds, i) => {
                  const day = Number(ds.slice(-2));
                  const isToday = ds === todayStr;
                  return (
                    <div
                      key={ds}
                      className="border-l border-border py-1 text-center"
                    >
                      <div
                        className={
                          "text-[10px] " +
                          (i === 0
                            ? "text-rose-500"
                            : i === 6
                              ? "text-sky-500"
                              : "text-muted-foreground")
                        }
                      >
                        {WEEKDAYS[i]}
                      </div>
                      <div
                        className={
                          "mx-auto flex h-7 w-7 items-center justify-center rounded-full text-sm " +
                          (isToday
                            ? "bg-primary font-bold text-primary-foreground"
                            : "font-medium")
                        }
                      >
                        {day}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* 終日（時刻なしの記録・見送り） */}
              <div className="grid grid-cols-[3rem_repeat(7,1fr)] border-b border-border">
                <div className="py-1 pr-1 text-right text-[10px] text-muted-foreground">
                  終日
                </div>
                {weekDays.map((ds) => (
                  <div
                    key={ds}
                    className="min-h-6 border-l border-border p-0.5"
                  >
                    {(itemsByDate[ds] ?? [])
                      .filter((x) => x.status === "skipped" || !x.start)
                      .map((x) => (
                        <button
                          key={x.id}
                          type="button"
                          onClick={() => open(ds, x.id)}
                          aria-label={`${formatDay(ds)} ${
                            x.status === "skipped" ? "見送り" : "時刻なしの記録"
                          } ${x.body || SOURCE_LABEL[x.source]}`}
                          className={
                            "block w-full truncate rounded bg-surface-muted px-1 text-left text-[10px] " +
                            (x.status === "skipped"
                              ? "text-muted-foreground line-through"
                              : "text-foreground")
                          }
                        >
                          {SOURCE_EMOJI[x.source]}
                          {x.body || SOURCE_LABEL[x.source]}
                        </button>
                      ))}
                  </div>
                ))}
              </div>

              {/* 時間軸 + ブロック */}
              <div className="grid grid-cols-[3rem_repeat(7,1fr)]">
                <div className="relative" style={{ height: gridH }}>
                  {Array.from(
                    { length: hEnd - hStart },
                    (_, i) => hStart + i,
                  ).map((h) => (
                    <div
                      key={h}
                      className="absolute right-1 -translate-y-1/2 text-[10px] tabular-nums text-muted-foreground"
                      style={{ top: (h - hStart) * ROW }}
                    >
                      {pad(h)}:00
                    </div>
                  ))}
                </div>
                {weekDays.map((ds) => {
                  const list = (itemsByDate[ds] ?? []).filter(
                    (x) => x.status !== "skipped" && x.start && x.end,
                  );
                  return (
                    <div
                      key={ds}
                      className="relative border-l border-border"
                      style={{ height: gridH }}
                    >
                      {Array.from(
                        { length: hEnd - hStart },
                        (_, i) => hStart + i,
                      ).map((h) => (
                        <div
                          key={h}
                          className="absolute inset-x-0 border-t border-border"
                          style={{ top: (h - hStart) * ROW }}
                        />
                      ))}
                      {layout(list).map(({ x, g, col, total }) => {
                        const c = COLOR[x.source];
                        const done = x.status === "done";
                        const who = rolesFor(x.source)
                          .map((r) => memberOf(x.who[r]))
                          .filter(Boolean);
                        return (
                          <button
                            key={x.id}
                            type="button"
                            onClick={() => open(ds, x.id)}
                            aria-label={`${formatDay(ds)} ${x.start}から${x.end} ${
                              SOURCE_LABEL[x.source]
                            }${done ? " 記録ずみ" : ""}`}
                            className={
                              "absolute flex flex-col items-stretch justify-start overflow-hidden rounded border-l-4 px-1 py-0.5 text-left text-[10px] leading-tight " +
                              (done ? `${c.solid} border-l-black/20` : c.soft) +
                              (x.fromRule ? " border-dashed" : "")
                            }
                            style={{
                              top: g.top,
                              height: g.h,
                              left: `calc(${(col / total) * 100}% + 2px)`,
                              width: `calc(${100 / total}% - 4px)`,
                            }}
                          >
                            <span className="block truncate font-medium">
                              {SOURCE_EMOJI[x.source]} {SOURCE_LABEL[x.source]}
                            </span>
                            <span className="block truncate tabular-nums">
                              {x.start}〜{x.end}
                            </span>
                            {who.length > 0 && (
                              <span className="mt-0.5 flex gap-0.5">
                                {who.map((m) => (
                                  <span
                                    key={m!.id}
                                    className="flex h-4 w-4 items-center justify-center rounded-full bg-surface text-[9px] font-bold text-foreground ring-1 ring-border"
                                  >
                                    {m!.initial}
                                  </span>
                                ))}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      <p className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full border-[1.5px] border-sky-500" />{" "}
          予定
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-sky-500" /> 記録ずみ
        </span>
        <span className="flex items-center gap-1">
          <span className="text-muted-foreground line-through">見送り</span>
        </span>
      </p>

      {mounted &&
        openDate &&
        createPortal(
          <>
            <div
              onClick={requestClose}
              className="fixed inset-0 z-40 bg-black/40 transition-opacity"
              aria-hidden="true"
            />
            <div
              ref={sheetRef}
              role="dialog"
              aria-modal="true"
              aria-label={`${formatDay(openDate)}の予定`}
              tabIndex={-1}
              className="fixed inset-x-0 bottom-0 z-50 max-h-[88dvh] overflow-y-auto rounded-t-2xl bg-surface shadow-lg outline-none ring-1 ring-border"
            >
              <div className="mx-auto max-w-2xl px-4 pb-[calc(1.5rem+env(safe-area-inset-bottom))] pt-3">
                <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-muted" />
                <div className="mb-3 flex items-center justify-between gap-2">
                  <h2 className="min-w-0 flex-1 truncate text-base font-bold">
                    {formatDay(openDate)}
                  </h2>
                  {openItem && (
                    <span className="shrink-0 rounded-full bg-surface-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                      {statusLabel(openItem.status, openItem.fromRule)}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={requestClose}
                    aria-label="閉じる"
                    className="rounded-full p-1.5 text-muted-foreground transition hover:bg-surface-muted"
                  >
                    <X className="h-5 w-5" aria-hidden="true" />
                  </button>
                </div>

                {confirmClose && (
                  <div
                    ref={confirmRef}
                    role="alert"
                    tabIndex={-1}
                    className="mb-4 space-y-2 rounded-xl border border-border bg-surface-muted p-3 outline-none"
                  >
                    <p className="text-sm font-medium">
                      {pendingSwitch
                        ? "編集をやめて、そちらを開きますか？"
                        : "編集をやめますか？"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      保存していない変更は失われます。
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setConfirmClose(false);
                          setPendingSwitch(null);
                        }}
                        className="flex-1 rounded-lg border border-border bg-surface py-2.5 text-sm font-medium"
                      >
                        編集に戻る
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const target = pendingSwitch
                            ? openItems.find((x) => x.id === pendingSwitch)
                            : null;
                          if (target) switchTo(target);
                          else close();
                        }}
                        className="flex-1 rounded-lg bg-foreground py-2.5 text-sm font-bold text-background"
                      >
                        {pendingSwitch ? "開く" : "やめる"}
                      </button>
                    </div>
                  </div>
                )}

                {openItem?.status === "done" && (
                  <div className="mb-4 rounded-xl bg-surface-muted p-3">
                    <p className="mb-1 text-xs font-bold text-muted-foreground">
                      記録
                    </p>
                    <p className="text-sm">{openItem.body || "（本文なし）"}</p>
                    <Link
                      href={`/records/${openItem.id}`}
                      className="mt-2 inline-block rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium transition hover:bg-surface-muted"
                    >
                      記録を開く
                    </Link>
                  </div>
                )}

                {/* 戻したらシートを閉じる。開いたままだと、いま出ている下書き
                    （既定の保育園）が、戻ってきた別の種類のルールの内容として
                    保存されてしまう */}
                {skipped.has(openDate) && canEdit && (
                  <form
                    action={submit(restoreRuleForDate)}
                    className="mb-4 flex items-center gap-2 rounded-xl border border-dashed border-border p-3 text-sm"
                  >
                    <input type="hidden" name="record_date" value={openDate} />
                    {householdId && (
                      <input
                        type="hidden"
                        name="household_id"
                        value={householdId}
                      />
                    )}
                    <span className="min-w-0 flex-1 text-muted-foreground">
                      毎週のルールを打ち消しています。
                    </span>
                    <button
                      type="submit"
                      className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs font-medium transition hover:bg-surface-muted"
                    >
                      戻す
                    </button>
                  </form>
                )}

                {readOnly ? (
                  <p className="rounded-xl bg-surface-muted px-3 py-2 text-xs text-muted-foreground">
                    閲覧のみの権限のため、変更できません。
                  </p>
                ) : (
                  <form action={submit(savePlan)} className="space-y-4">
                    <input type="hidden" name="record_date" value={openDate} />
                    <input
                      type="hidden"
                      name="record_id"
                      value={openItem && !openItem.fromRule ? openItem.id : ""}
                    />
                    <input type="hidden" name="draft_id" value={draftId} />
                    {/* ペットが 2 頭以上のときだけ選ばせる。1 頭なら
                        Server Action がその子を当てる */}
                    {pets.length > 1 && (!openItem || openItem.fromRule) && (
                      <div>
                        <label
                          htmlFor="schedule-pet"
                          className="mb-1 block text-xs font-bold text-muted-foreground"
                        >
                          どの子
                        </label>
                        <select
                          id="schedule-pet"
                          name="pet_id"
                          defaultValue=""
                          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
                        >
                          <option value="">（未設定）</option>
                          {pets.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                    {householdId && (
                      <input
                        type="hidden"
                        name="household_id"
                        value={householdId}
                      />
                    )}
                    {additional && (
                      <input type="hidden" name="additional" value="1" />
                    )}
                    {(["drop", "pick", "care"] as AssigneeRole[]).map(
                      (role) => (
                        <input
                          key={role}
                          type="hidden"
                          name={`who_${role}`}
                          value={draft.who[role] ?? ""}
                        />
                      ),
                    )}

                    <div>
                      <p className="mb-2 text-xs font-bold text-muted-foreground">
                        どう過ごす？
                      </p>
                      <div
                        role="radiogroup"
                        aria-label="種類"
                        className="flex flex-wrap gap-2"
                      >
                        {RECORD_SOURCES.map((s) => {
                          const on = draft.source === s;
                          return (
                            <button
                              key={s}
                              type="button"
                              role="radio"
                              aria-checked={on}
                              data-type={s}
                              onClick={() => pickType(s)}
                              className={
                                "rounded-full border px-3 py-1.5 text-sm transition " +
                                (on
                                  ? `${COLOR[s].soft} font-bold`
                                  : "border-border text-muted-foreground hover:bg-surface-muted")
                              }
                            >
                              {SOURCE_EMOJI[s]} {SOURCE_LABEL[s]}
                            </button>
                          );
                        })}
                      </div>
                      <input type="hidden" name="source" value={draft.source} />
                    </div>

                    <div>
                      <p className="mb-2 text-xs font-bold text-muted-foreground">
                        時間
                      </p>
                      <div className="flex items-center gap-2">
                        <input
                          type="time"
                          name="start_time"
                          aria-label="開始時刻"
                          value={draft.start}
                          onChange={(e) =>
                            setDraft((d) => ({
                              ...d,
                              start: e.target.value,
                              timeDirty: true,
                            }))
                          }
                          className="min-w-0 flex-1 rounded-xl border border-border bg-surface px-3 py-2.5 text-sm tabular-nums"
                        />
                        <span className="shrink-0 text-sm text-muted-foreground">
                          〜
                        </span>
                        <input
                          type="time"
                          name="end_time"
                          aria-label="終了時刻"
                          value={draft.end}
                          onChange={(e) =>
                            setDraft((d) => ({
                              ...d,
                              end: e.target.value,
                              timeDirty: true,
                            }))
                          }
                          className="min-w-0 flex-1 rounded-xl border border-border bg-surface px-3 py-2.5 text-sm tabular-nums"
                        />
                      </div>
                    </div>

                    {roles.length > 0 && (
                      <div className="space-y-3 rounded-xl bg-surface-muted p-3">
                        {roles.map((role) => (
                          <div
                            key={role}
                            className="flex flex-wrap items-center gap-2"
                          >
                            <span className="w-20 shrink-0 text-sm font-medium">
                              {ASSIGNEE_ROLE_LABEL[role]}
                            </span>
                            {members.map((m) => {
                              const on = draft.who[role] === m.id;
                              return (
                                <button
                                  key={m.id}
                                  type="button"
                                  data-who={`${role}:${m.id}`}
                                  aria-pressed={on}
                                  aria-label={`${ASSIGNEE_ROLE_LABEL[role]}は${m.name}`}
                                  onClick={() => toggleWho(role, m.id)}
                                  className={
                                    "flex items-center gap-1.5 rounded-full py-1 pl-1 pr-3 text-xs transition " +
                                    (on
                                      ? "bg-surface font-bold shadow-sm ring-2 ring-primary"
                                      : "text-muted-foreground hover:bg-surface")
                                  }
                                >
                                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
                                    {m.initial}
                                  </span>
                                  {m.name}
                                </button>
                              );
                            })}
                          </div>
                        ))}
                      </div>
                    )}

                    <div>
                      <label
                        className="mb-1 block text-xs font-medium text-muted-foreground"
                        htmlFor="plan-note"
                      >
                        ひとことメモ（任意）
                      </label>
                      <input
                        id="plan-note"
                        name="body"
                        value={draft.body}
                        onChange={(e) =>
                          setDraft((d) => ({ ...d, body: e.target.value }))
                        }
                        placeholder="例: パパ出張のため、迎えはばあば"
                        className="w-full rounded-xl border border-border bg-surface px-3 py-2.5 text-sm"
                      />
                    </div>

                    {(!openItem || openItem.status === "planned") && (
                      <label className="flex items-center gap-2 text-sm">
                        <input type="checkbox" name="repeat" value="1" />
                        これから毎週
                        {WEEKDAYS[new Date(`${openDate}T00:00:00`).getDay()]}
                        曜も同じにする
                      </label>
                    )}

                    <SubmitButton className="w-full rounded-xl bg-primary py-3 text-sm font-bold text-primary-foreground transition hover:bg-primary-hover">
                      {openItem?.status === "done"
                        ? "変更を保存する"
                        : "予定を保存する"}
                    </SubmitButton>

                    {(!openItem || openItem.status === "planned") && (
                      <div className="flex gap-2">
                        <SubmitButton
                          formAction={submit(completePlan)}
                          className="flex-1 rounded-xl border-2 border-emerald-600 py-2.5 text-sm font-bold text-emerald-800 transition hover:bg-emerald-50 dark:border-emerald-400 dark:text-emerald-300 dark:hover:bg-emerald-950"
                        >
                          <Check
                            className="mr-1 inline h-4 w-4"
                            aria-hidden="true"
                          />
                          完了して記録にする
                        </SubmitButton>
                        {openItem && (
                          <SubmitButton
                            formAction={submit(skipPlan)}
                            className="rounded-xl border border-border px-3 py-2.5 text-sm font-medium text-muted-foreground transition hover:bg-surface-muted"
                          >
                            見送り
                          </SubmitButton>
                        )}
                      </div>
                    )}

                    {openItem &&
                      openItem.status === "skipped" &&
                      !openItem.fromRule && (
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => run(() => reopenPlan(openItem.id))}
                          className="w-full rounded-xl border border-border py-2.5 text-sm font-medium transition hover:bg-surface-muted disabled:opacity-50"
                        >
                          予定に戻す
                        </button>
                      )}

                    {/* 消せるのは予定だけ。記録・見送りは履歴なので、写真ごと消える
                        取り返しのつかない操作を確認なしで置かない（記録の削除は
                        記録詳細の「…」から確認つきで行う） */}
                    {/* 「もう 1 件足す」の下書き（additional）には出さない ——
                        record_id が空のまま送ると、その日のルールごと打ち消して
                        しまい、保存していない下書きを捨てるだけにならない */}
                    {!additional &&
                      (!openItem || openItem.status === "planned") && (
                        <SubmitButton
                          formAction={submit(clearPlan)}
                          className="w-full rounded-xl py-2.5 text-sm font-medium text-muted-foreground transition hover:bg-surface-muted"
                        >
                          この日の予定を消す
                        </SubmitButton>
                      )}
                  </form>
                )}

                {canEdit && openItem && (
                  <button
                    type="button"
                    onClick={() => {
                      // record_id を空にした下書きに切り替える（既存を書き換えず、
                      // 保育園の隣に通院を足せるようにする）
                      setOpenId(null);
                      const next = draftOf(null);
                      setDraft(next);
                      setOpenDraft(next);
                      setConfirmClose(false);
                      setPendingSwitch(null);
                      setAdditional(true);
                      setDraftId(crypto.randomUUID());
                    }}
                    className="mt-3 w-full rounded-xl border border-dashed border-border py-2.5 text-sm font-medium text-muted-foreground transition hover:bg-surface-muted"
                  >
                    ＋ この日に予定をもう 1 件足す
                  </button>
                )}

                {openItems.filter((x) => x.id !== openItem?.id).length > 0 && (
                  <div className="mt-4">
                    <p className="mb-2 text-xs font-bold text-muted-foreground">
                      この日のほかの記録・予定
                    </p>
                    <ul className="space-y-1.5">
                      {openItems
                        .filter((x) => x.id !== openItem?.id)
                        .map((x) => (
                          <li key={x.id}>
                            <button
                              type="button"
                              onClick={() => {
                                if (dirty()) {
                                  setPendingSwitch(x.id);
                                  setConfirmClose(true);
                                  requestAnimationFrame(() =>
                                    confirmRef.current?.focus({
                                      preventScroll: true,
                                    }),
                                  );
                                  return;
                                }
                                switchTo(x);
                              }}
                              className="flex w-full items-center gap-2 rounded-xl bg-surface-muted px-3 py-2 text-left text-sm transition hover:bg-muted/40"
                            >
                              <span className="shrink-0">
                                {SOURCE_EMOJI[x.source]}
                              </span>
                              <span className="min-w-0 flex-1 truncate">
                                {x.body || SOURCE_LABEL[x.source]}
                              </span>
                              <span className="shrink-0 text-xs text-muted-foreground">
                                {statusLabel(x.status, x.fromRule)}
                              </span>
                            </button>
                          </li>
                        ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          </>,
          document.body,
        )}
    </>
  );
}
