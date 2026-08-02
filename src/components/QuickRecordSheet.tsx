"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Plus, X } from "lucide-react";
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

// 今日の日付（端末ローカル）。record_date は日付のみを持つ。
function todayISO(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function formatToday(): string {
  return new Intl.DateTimeFormat("ja-JP", {
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

  const fabRef = useRef<HTMLButtonElement>(null);
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

  // Escape で閉じる（キーボード/スイッチ利用者の脱出路）
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeSheet();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function openSheet() {
    setError(null);
    setOpen(true);
    // 開いた直後はダイアログ自体へフォーカス（IME は開かない）
    requestAnimationFrame(() => sheetRef.current?.focus({ preventScroll: true }));
  }

  function closeSheet() {
    setOpen(false);
    // モーダルを閉じたらフォーカスを開いた場所（FAB）へ戻す
    requestAnimationFrame(() => fabRef.current?.focus({ preventScroll: true }));
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

  function save() {
    if (!body || isPending) return;
    const fd = new FormData();
    fd.set("record_date", todayISO());
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
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  return (
    <>
      {/* FAB: クイック記録の入口（親指の届く右下・セーフエリア回避） */}
      <button
        ref={fabRef}
        type="button"
        onClick={openSheet}
        aria-haspopup="dialog"
        data-quick-record-bg
        className="fixed right-4 bottom-[calc(1.25rem+env(safe-area-inset-bottom))] z-40 flex h-14 items-center gap-2 rounded-full bg-primary pl-4 pr-5 text-sm font-medium text-primary-foreground shadow-lg transition hover:bg-primary-hover"
      >
        <Plus className="h-5 w-5" aria-hidden="true" />
        クイック記録
      </button>

      {/* 背景 */}
      <div
        onClick={closeSheet}
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
          "fixed inset-x-0 bottom-0 z-50 rounded-t-2xl bg-surface shadow-lg ring-1 ring-border transition-transform duration-300 " +
          (open ? "translate-y-0" : "translate-y-full")
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
                onClick={closeSheet}
                aria-label="閉じる"
                className="rounded-full p-1.5 text-muted-foreground transition hover:bg-surface-muted"
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
        </div>
      </div>

      {/* トースト（保存成功時のみテキストを入れて role=status で読み上げ） */}
      <div
        role="status"
        className={
          "pointer-events-none fixed left-1/2 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-50 -translate-x-1/2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-lg transition-opacity duration-300 " +
          (toast ? "opacity-100" : "opacity-0")
        }
      >
        {toast}
      </div>
    </>
  );
}
