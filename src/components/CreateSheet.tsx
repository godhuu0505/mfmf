"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarPlus, NotebookPen, X } from "lucide-react";
import { jstTodayISO } from "@/lib/dateRange";
import { lockModalBackground } from "@/lib/modalBackground";

// タブバー中央の「作成」から開くシート（D36）。
// クイック記録（チップで 1 件残す）はここで廃止し、入口を
// 「予定を入れる」「記録を残す」の二択にした —— どちらも既存の画面
// （カレンダーの日別シート / 記録フォーム）へ渡すだけで、ここでは保存しない。

/** 作成先の日付は JST の今日（カレンダー・一覧の「今日」と揃える）。 */
function todayLabel(): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(new Date());
}

export default function CreateSheet() {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  // シートを開いた要素（タブバー中央ボタン）。閉じたらここへフォーカスを戻す。
  const triggerRef = useRef<HTMLElement | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  // 表示中は背景（[data-app-modal-bg]）を inert にして、Tab / 支援技術が
  // モーダルの外へ出ないようにする（タブバー自身も対象）。
  // 直に inert を書き戻さないのが要点 —— 「予定」でカレンダーの日別シートへ
  // 持ち替えるとき、閉じる側の後始末が開いた側の inert を消してしまう
  // （数え方は src/lib/modalBackground.ts）。
  useEffect(() => {
    if (!open) return;
    return lockModalBackground();
  }, [open]);

  // タブバーの中央「＋」（AppTabBar）からのイベントで開く。
  useEffect(() => {
    const onOpen = () => {
      if (document.activeElement instanceof HTMLElement) {
        triggerRef.current = document.activeElement;
      }
      setOpen(true);
      requestAnimationFrame(() =>
        sheetRef.current?.focus({ preventScroll: true }),
      );
    };
    window.addEventListener("mfmf:create-open", onOpen);
    return () => window.removeEventListener("mfmf:create-open", onOpen);
  }, []);

  // Escape で閉じる（キーボード/スイッチ利用者の脱出路）
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function close() {
    setOpen(false);
    requestAnimationFrame(() =>
      triggerRef.current?.focus({ preventScroll: true }),
    );
  }

  /**
   * 予定: カレンダーの日別シート（きょう）を開く。
   * すでにカレンダーを開いているときは、URL を差し替えても ?open= が同じ値の
   * ままで開き直せない場面があるので、イベントで直接開く。
   *
   * 判定に usePathname / useSearchParams を使わない —— このシートは
   * レイアウトに常駐しており、フックで検索パラメータを読むと、そのぶん
   * 検索パラメータだけが変わる遷移（一覧の絞り込みチップなど）に
   * レイアウト側が巻き込まれる。ここで要るのは押した瞬間の現在地だけなので、
   * window.location を直接見る。
   */
  function createPlan() {
    const today = jstTodayISO();
    const ym = today.slice(0, 7);
    close();
    if (window.location.pathname === "/calendar") {
      const current = new URLSearchParams(window.location.search);
      // すでに今日の月・同じ ?open= を見ている（開いて閉じた直後）ときだけ、
      // URL が変わらず開き直せないのでイベントで直接開く。
      if (current.get("open") === today && (current.get("ym") ?? ym) === ym) {
        window.dispatchEvent(
          new CustomEvent("mfmf:open-plan", { detail: today }),
        );
        return;
      }
      // 表示（月/週）は保つが、**範囲は必ず今日へ寄せる** —— 別の月を見たまま
      // 開くと、その月ぶんしか取っていない一覧に今日が無く、すでにある予定が
      // 「空の新規」に見えてしまう（保存すると二重／ルールの上書きになる）。
      const params = new URLSearchParams();
      if (current.get("view") === "week") params.set("view", "week");
      params.set("ym", ym);
      params.set("w", today);
      params.set("open", today);
      router.push(`/calendar?${params.toString()}`);
      return;
    }
    router.push(`/calendar?ym=${ym}&open=${today}`);
  }

  /** 記録: これまでどおり記録フォーム（写真・体重・タグまで書ける）へ。 */
  function createRecord() {
    close();
    router.push("/records/new");
  }

  return (
    <>
      {/* 背景 */}
      <div
        onClick={close}
        aria-hidden="true"
        className={
          "fixed inset-0 z-40 bg-black/40 transition-opacity duration-300 " +
          (open ? "opacity-100" : "pointer-events-none opacity-0")
        }
      />

      {/* ボトムシート（閉じている間は inert でフォーカス・支援技術から外す） */}
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label="作成"
        inert={!open}
        tabIndex={-1}
        className={
          // visibility も transition に含める: 閉じるときはスライド完了後に hidden
          // になり、開くときは即 visible に戻る（QuickRecordSheet から踏襲）。
          "fixed inset-x-0 bottom-0 z-50 rounded-t-2xl bg-surface shadow-lg ring-1 ring-border transition-[transform,visibility] duration-300 " +
          (open ? "visible translate-y-0" : "invisible translate-y-full")
        }
      >
        <div className="mx-auto max-w-2xl px-4 pt-3 pb-[calc(1rem+env(safe-area-inset-bottom))]">
          <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-muted" />

          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-bold text-foreground">作成</h2>
            <div className="flex items-center gap-2">
              <p className="text-sm text-muted-foreground">
                {open ? todayLabel() : ""}
              </p>
              <button
                type="button"
                onClick={close}
                aria-label="閉じる"
                className="rounded-full p-1.5 text-muted-foreground transition hover:bg-surface-muted"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>
          </div>

          {/* 選択肢はアプリの他のシート（RecordActionsSheet）と同じ行グループに
              揃える —— 角丸のかたまりに行を積み、アイコンは h-5・muted */}
          <div className="mb-2 overflow-hidden rounded-xl bg-surface-muted">
            <button
              type="button"
              onClick={createPlan}
              className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition hover:bg-muted"
            >
              <CalendarPlus
                className="h-5 w-5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-foreground">
                  予定
                </span>
                <span className="block text-xs text-muted-foreground">
                  これからの予定を入れる（担当・時間も決められます）
                </span>
              </span>
            </button>

            <div className="border-t border-border" />

            <button
              type="button"
              onClick={createRecord}
              className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition hover:bg-muted"
            >
              <NotebookPen
                className="h-5 w-5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-foreground">
                  記録
                </span>
                <span className="block text-xs text-muted-foreground">
                  あったことを残す（写真・体重もつけられます）
                </span>
              </span>
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
