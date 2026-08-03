"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";

// 記録フォームのキャンセル / 保存に挟む確認ダイアログ（D33 実機合意）。
// LogoutConfirmDialog と同じ作法（body 直下ポータル・スクロールロック・Esc）。

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  confirmClassName,
  onConfirm,
  onClose,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  confirmClassName: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  // モーダルの作法: 開いたらダイアログへフォーカスを移し、背景（body 直下の
  // 兄弟要素）を inert にする。閉じたら元のトリガーへフォーカスを戻す。
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prevFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const dialogEl = rootRef.current;
    const others = Array.from(document.body.children).filter(
      (el): el is HTMLElement => el instanceof HTMLElement && el !== dialogEl,
    );
    const prevInert = others.map((el) => el.inert);
    others.forEach((el) => {
      el.inert = true;
    });
    requestAnimationFrame(() =>
      rootRef.current?.focus({ preventScroll: true }),
    );
    return () => {
      others.forEach((el, i) => {
        el.inert = prevInert[i];
      });
      prevFocus?.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={rootRef}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="form-confirm-title"
    >
      <button
        type="button"
        aria-label="閉じる"
        onClick={onClose}
        className="absolute inset-0 bg-black/40"
      />
      <div className="relative z-10 w-full max-w-sm rounded-2xl bg-surface p-6 shadow-xl">
        <h2
          id="form-confirm-title"
          className="text-base font-semibold text-foreground"
        >
          {title}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {message}
        </p>
        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground transition hover:bg-surface-muted"
          >
            もどる
          </button>
          <button type="button" onClick={onConfirm} className={confirmClassName}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// フォームの「保存」ボタン。押すと確認ダイアログを出し、確認後に最も近い
// <form> を requestSubmit する（Server Action / onSubmit どちらの form でも動く）。
export function ConfirmSubmitButton({
  children,
  className,
  title = "この内容で保存しますか？",
  message = "保存したあともいつでも編集できます。",
}: {
  children: React.ReactNode;
  className: string;
  title?: string;
  message?: string;
}) {
  const [open, setOpen] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        disabled={submitted}
        onClick={() => setOpen(true)}
        className={className}
      >
        {submitted ? "保存中…" : children}
      </button>
      {open && (
        <ConfirmDialog
          title={title}
          message={message}
          confirmLabel="保存する"
          confirmClassName="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary-hover"
          onClose={() => setOpen(false)}
          onConfirm={() => {
            setOpen(false);
            const form = btnRef.current?.closest("form");
            // 必須項目エラー時はブラウザの検証メッセージに任せ、ボタンは押せるまま残す
            if (form && !form.checkValidity()) {
              form.reportValidity();
              return;
            }
            setSubmitted(true);
            form?.requestSubmit();
          }}
        />
      )}
    </>
  );
}

// フォームの「キャンセル」。押すと破棄の確認を出し、確認後に href へ戻る。
export function ConfirmCancelButton({
  href,
  className,
  label = "キャンセル",
}: {
  href: string;
  className: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className}>
        {label}
      </button>
      {open && (
        <ConfirmDialog
          title="編集をやめますか？"
          message="入力した内容は保存されません。"
          confirmLabel="破棄してもどる"
          confirmClassName="rounded-lg border border-border px-4 py-2 text-sm font-medium text-red-600 transition hover:bg-surface-muted dark:text-red-400"
          onClose={() => setOpen(false)}
          onConfirm={() => router.push(href)}
        />
      )}
    </>
  );
}
