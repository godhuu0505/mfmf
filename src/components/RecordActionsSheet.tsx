"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { EllipsisVertical, Pencil, Trash2, X } from "lucide-react";

// 記録詳細の「…」メニュー（UC-D01 / D33）。編集への導線と、確認つきの削除を持つ。
// 削除の実体は Server Action の form（children で受け取る）に任せる。
export default function RecordActionsSheet({
  editHref,
  shareForm,
  deleteForm,
}: {
  editHref: string;
  /** setRecordGuestVisible を action に持つ <form>（ペット紐付き記録のみ） */
  shareForm?: React.ReactNode;
  /** deleteRecord を action に持つ <form>（送信ボタンごと） */
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
        aria-label="その他の操作"
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground transition hover:bg-surface-muted"
      >
        <EllipsisVertical className="h-5 w-5" aria-hidden="true" />
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
        aria-label="その他の操作"
        inert={!open}
        tabIndex={-1}
        className={
          "fixed inset-x-0 bottom-0 z-50 rounded-t-2xl bg-surface shadow-lg ring-1 ring-border transition-[transform,visibility] duration-300 " +
          (open ? "visible translate-y-0" : "invisible translate-y-full")
        }
      >
        <div className="mx-auto max-w-2xl px-4 pt-3 pb-[calc(1rem+env(safe-area-inset-bottom))]">
          <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-muted" />
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-base font-bold text-foreground">
              {confirming ? "この記録を削除しますか？" : "この記録の操作"}
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
                削除すると、この記録と写真は元に戻せません。
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
            <div className="overflow-hidden rounded-xl bg-surface-muted">
              <Link
                href={editHref}
                className="flex w-full items-center gap-3 px-4 py-3.5 text-left text-sm font-medium text-foreground transition hover:bg-muted"
              >
                <Pencil
                  className="h-5 w-5 text-muted-foreground"
                  aria-hidden="true"
                />
                編集する
              </Link>
              {shareForm && (
                <>
                  <div className="border-t border-border" />
                  {shareForm}
                </>
              )}
              <div className="border-t border-border" />
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="flex w-full items-center gap-3 px-4 py-3.5 text-left text-sm font-medium text-red-600 transition hover:bg-muted dark:text-red-400"
              >
                <Trash2 className="h-5 w-5" aria-hidden="true" />
                この記録を削除する
              </button>
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
