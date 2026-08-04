"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { jstTodayISO } from "@/lib/dateRange";
import { saveQuickDraft } from "@/lib/quickDraft";
import type { RecordSource } from "@/types/database";

// クイック記録の定型チップ（proto/quick-record 合意時の語彙 / D32）。
// タップで選んだ順に「、」で繋がって本文になる。IME を開かずに 1 件残せる。
const CHIPS = [
  "ごはん完食",
  "ごはん少なめ",
  "おやつ",
  "さんぽ",
  "トイレOK",
  "おくすり",
  "ねんね",
  "ごきげん",
];

// 表示・保存とも JST の「今日」（record_date は日付のみを持つ。
// 一覧の「今日/昨日」見出しも Asia/Tokyo 基準なので揃える）。
function formatToday(): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(new Date());
}

type Props = {
  /** createQuickRecord（Server Action）。作成後は redirect せずホームに留まる。 */
  action: (formData: FormData) => Promise<void>;
  /** シートを描画した世帯（hidden で送信し、Server Action 側でこの世帯の editor+ を検証） */
  householdId: string;
  /** プロフィールの既定記入者（画面には出さない） */
  defaultAuthor: string;
};

export default function QuickRecordSheet({
  action,
  householdId,
  defaultAuthor,
}: Props) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [source, setSource] = useState<RecordSource>("home");
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  // タブバー中央ボタン等、シートを開いた要素。閉じたらここへフォーカスを戻す。
  const triggerRef = useRef<HTMLElement | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const noteInputRef = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const body = [...selected, note.trim()].filter(Boolean).join("、");

  // シート表示中は背景（[data-quick-record-bg]）を inert にして
  // Tab / 支援技術がモーダルの外へ出ないようにする（FAB 自身も対象）。
  useEffect(() => {
    const els = document.querySelectorAll<HTMLElement>("[data-quick-record-bg]");
    els.forEach((el) => {
      el.inert = open;
    });
    return () => {
      els.forEach((el) => {
        el.inert = false;
      });
    };
  }, [open]);

  // 他タブでの世帯切替（UC-H08 → HouseholdSyncRefresher の refresh）で
  // householdId が変わったら、開いていた下書きは破棄して閉じる。見えている
  // 下書きのまま保存すると、気づかないうちに別世帯へ記録してしまうため。
  const prevHouseholdRef = useRef(householdId);
  useEffect(() => {
    if (prevHouseholdRef.current === householdId) return;
    prevHouseholdRef.current = householdId;
    setOpen(false);
    resetSheet();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [householdId]);

  // タブバーの中央「＋」（AppTabBar）からのイベントで開く（D33 で FAB を廃止）。
  // 発火元の要素を覚えておき、閉じたらそこへフォーカスを戻す。
  useEffect(() => {
    const onOpen = () => {
      if (document.activeElement instanceof HTMLElement) {
        triggerRef.current = document.activeElement;
      }
      openSheet();
    };
    window.addEventListener("mfmf:quick-record-open", onOpen);
    return () => window.removeEventListener("mfmf:quick-record-open", onOpen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Escape で閉じる（キーボード/スイッチ利用者の脱出路）
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismissSheet();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isPending]);

  function openSheet() {
    setError(null);
    setOpen(true);
    // 開いた直後はダイアログ自体へフォーカス（IME は開かない）
    requestAnimationFrame(() => sheetRef.current?.focus({ preventScroll: true }));
  }

  function closeSheet() {
    setOpen(false);
    // モーダルを閉じたらフォーカスを開いた場所（タブバーの中央ボタン等）へ戻す
    requestAnimationFrame(() =>
      triggerRef.current?.focus({ preventScroll: true }),
    );
  }

  // ユーザー操作（X・背景・Escape）による閉じる。保存中は無効にする —— 閉じて
  // 開き直した下書きを、遅れて完了した保存処理の後始末が消してしまわないように。
  function dismissSheet() {
    if (isPending) return;
    closeSheet();
  }

  function resetSheet() {
    setSelected([]);
    setNote("");
    setNoteOpen(false);
    setSource("home"); // 既定はおうちへ毎回戻す（spec）
  }

  function toggleChip(chip: string) {
    setSelected((prev) =>
      prev.includes(chip) ? prev.filter((c) => c !== chip) : [...prev, chip],
    );
  }

  // 「写真つきでくわしく記録する →」（proto 合意の導線）。クイックの下書き
  // （チップ・ひとこと・記録元）を sessionStorage で /records/new に引き継ぐ
  // （本文はプライベートなメモなので URL・履歴・ログに載せない）。
  function openDetailedForm() {
    if (isPending) return;
    saveQuickDraft({ body, source });
    closeSheet();
    resetSheet();
    router.push("/records/new");
  }

  function save() {
    if (!body || isPending) return;
    const fd = new FormData();
    fd.set("record_date", jstTodayISO());
    fd.set("source", source);
    fd.set("author", defaultAuthor);
    fd.set("body", body);
    fd.set("household_id", householdId);
    startTransition(async () => {
      try {
        await action(fd);
      } catch {
        setError("保存に失敗しました。時間をおいて再度お試しください。");
        return;
      }
      closeSheet();
      resetSheet();
      if (toastTimer.current) clearTimeout(toastTimer.current);
      setToast("残しました");
      toastTimer.current = setTimeout(() => setToast(""), 1800);
      // 絞り込み・並び替え・ページ中でも「一覧の先頭に出る」を成立させるため、
      // 保存後は絞り込みなしの先頭へ戻す（UC-Q06）。
      router.push("/");
    });
  }

  return (
    <>
      {/* 入口はタブバー中央の「＋」（AppTabBar → mfmf:quick-record-open イベント）。
          D33 で FAB は廃止した。 */}
      {/* 背景 */}
      <div
        onClick={dismissSheet}
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
        aria-label="クイック記録"
        inert={!open}
        tabIndex={-1}
        className={
          // visibility も transition に含める: 閉じるときはスライド完了後に hidden になり、
          // 開くときは即 visible に戻る（CSS の離散プロパティ遷移の標準挙動）。
          // translate だけだと「画面外にあるが visible」のままで、支援技術や
          // Playwright の可視性判定に閉じたことが伝わらない。
          "fixed inset-x-0 bottom-0 z-50 rounded-t-2xl bg-surface shadow-lg ring-1 ring-border transition-[transform,visibility] duration-300 " +
          (open ? "visible translate-y-0" : "invisible translate-y-full")
        }
      >
        <div className="mx-auto max-w-2xl px-4 pt-3 pb-[calc(1rem+env(safe-area-inset-bottom))]">
          <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-muted" />

          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-bold text-foreground">クイック記録</h2>
            <div className="flex items-center gap-2">
              <p className="text-sm text-muted-foreground">
                {open ? formatToday() : ""}
              </p>
              <button
                type="button"
                onClick={dismissSheet}
                disabled={isPending}
                aria-label="閉じる"
                className="rounded-full p-1.5 text-muted-foreground transition hover:bg-surface-muted disabled:opacity-40"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>
          </div>

          {error && (
            <p
              className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600"
              role="alert"
            >
              {error}
            </p>
          )}

          {/* どこでのできごとか（既定: おうち） */}
          <div
            className="mb-3 flex items-center gap-1.5"
            role="radiogroup"
            aria-label="どこでのできごと"
          >
            <button
              type="button"
              role="radio"
              aria-checked={source === "home"}
              onClick={() => setSource("home")}
              className={
                "rounded-full bg-amber-100 px-4 py-2 text-sm font-medium text-amber-900 " +
                (source === "home" ? "ring-2 ring-amber-400" : "ring-0")
              }
            >
              おうち
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={source === "daycare"}
              onClick={() => setSource("daycare")}
              className={
                "rounded-full bg-sky-100 px-4 py-2 text-sm font-medium text-sky-900 " +
                (source === "daycare" ? "ring-2 ring-sky-400" : "ring-0")
              }
            >
              保育園
            </button>
          </div>

          {/* ひとこと（任意）。案 A: 既定では畳んでおき、押したときだけ IME を開く */}
          {noteOpen ? (
            <div className="mb-3">
              <input
                ref={noteInputRef}
                type="text"
                enterKeyHint="done"
                placeholder="ひとこと（任意）"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2.5 text-base text-foreground placeholder:text-muted-foreground"
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setNoteOpen(true);
                requestAnimationFrame(() => noteInputRef.current?.focus());
              }}
              className="mb-3 inline-flex items-center gap-1 rounded-full bg-surface-muted px-3 py-1.5 text-sm font-medium text-muted-foreground transition hover:bg-muted"
            >
              ＋ ひとことを足す
            </button>
          )}

          {/* 定型チップ */}
          <div className="mb-4 flex flex-wrap gap-2" aria-label="定型のできごと">
            {CHIPS.map((chip) => {
              const active = selected.includes(chip);
              return (
                <button
                  key={chip}
                  type="button"
                  aria-pressed={active}
                  onClick={() => toggleChip(chip)}
                  className={
                    active
                      ? "rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition"
                      : "rounded-full bg-surface-muted px-4 py-2 text-sm font-medium text-muted-foreground transition hover:bg-muted"
                  }
                >
                  {chip}
                </button>
              );
            })}
          </div>

          {/* 本文プレビュー */}
          <p className="mb-3 min-h-6 text-sm text-muted-foreground">
            {body || "チップを選ぶか、ひとことを書いてください"}
          </p>

          <button
            type="button"
            onClick={save}
            disabled={!body || isPending}
            className="w-full rounded-lg bg-primary px-4 py-3 text-base font-medium text-primary-foreground transition hover:bg-primary-hover disabled:opacity-40"
          >
            {isPending ? "保存中…" : "保存する"}
          </button>

          <button
            type="button"
            onClick={openDetailedForm}
            disabled={isPending}
            className="mt-2 w-full py-2 text-center text-sm font-medium text-primary transition hover:text-primary-hover disabled:opacity-40"
          >
            写真つきでくわしく記録する →
          </button>
        </div>
      </div>

      {/* トースト（保存成功時のみテキストを入れて role=status で読み上げ） */}
      <div
        role="status"
        className={
          "pointer-events-none fixed left-1/2 bottom-[calc(env(safe-area-inset-bottom)+5.5rem)] z-50 -translate-x-1/2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-lg transition-opacity duration-300 " +
          (toast ? "opacity-100" : "opacity-0")
        }
      >
        {toast}
      </div>
    </>
  );
}
