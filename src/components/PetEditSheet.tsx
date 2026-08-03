"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Pencil, X } from "lucide-react";

// ペットの編集シート（D33 / proto 合意）。常時展開フォームをやめ、
// 鉛筆ボタン → ボトムシートで編集・削除する。フォーム本体（Server Action）は
// サーバー側から children で受け取る。
export default function PetEditSheet({
  petName,
  editForm,
  deleteForm,
}: {
  petName: string;
  /** updatePet を action に持つ <form> */
  editForm: React.ReactNode;
  /** deletePet を action に持つ <form>（送信ボタンごと） */
  deleteForm: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [confirming, setConfirming] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
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
  }, [open]);

  function openSheet() {
    setConfirming(false);
    setOpen(true);
    requestAnimationFrame(() =>
      sheetRef.current?.focus({ preventScroll: true }),
    );
  }

  function close() {
    setOpen(false);
    setConfirming(false);
    requestAnimationFrame(() =>
      triggerRef.current?.focus({ preventScroll: true }),
    );
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={openSheet}
        aria-haspopup="dialog"
        aria-label={`${petName}を編集`}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground transition hover:bg-surface-muted"
      >
        <Pencil className="h-5 w-5" aria-hidden="true" />
      </button>
      {mounted &&
        createPortal(
          <>

      <div
        onClick={close}
        aria-hidden="true"
        className={
          "fixed inset-0 z-40 bg-black/40 transition-opacity duration-300 " +
          (open ? "opacity-100" : "pointer-events-none opacity-0")
        }
      />
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={`${petName}を編集`}
        inert={!open}
        tabIndex={-1}
        className={
          "fixed inset-x-0 bottom-0 z-50 max-h-[85vh] overflow-y-auto rounded-t-2xl bg-surface shadow-lg ring-1 ring-border transition-[transform,visibility] duration-300 " +
          (open ? "visible translate-y-0" : "invisible translate-y-full")
        }
      >
        <div className="mx-auto max-w-2xl px-4 pt-3 pb-[calc(1rem+env(safe-area-inset-bottom))]">
          <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-muted" />
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-bold text-foreground">
              {confirming ? `${petName}を削除しますか？` : `${petName}を編集`}
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

          {confirming ? (
            <div className="space-y-3">
              <p className="text-sm leading-relaxed text-muted-foreground">
                削除すると元に戻せません。このペットに紐づく記録は残ります。
              </p>
              {deleteForm}
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="w-full rounded-xl border border-border py-2.5 text-sm font-medium text-foreground transition hover:bg-surface-muted"
              >
                キャンセル
              </button>
            </div>
          ) : (
            <>
              {editForm}
              <div className="mt-4 border-t border-border pt-3">
                <button
                  type="button"
                  onClick={() => setConfirming(true)}
                  className="text-sm font-medium text-red-600 transition hover:text-red-800 dark:text-red-400"
                >
                  このペットを削除する
                </button>
              </div>
            </>
          )}
        </div>
      </div>
          </>,
          document.body,
        )}
    </>
  );
}
