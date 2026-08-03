"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

// ログアウトの確認ダイアログ。AccountMenu（ヘッダー）と MenuLogoutItem（メニュー画面）
// の両方から使う。確認のうえ /auth/signout（Route Handler）へ POST する。
export default function LogoutConfirmDialog({
  onClose,
}: {
  onClose: () => void;
}) {
  // 背景のスクロールを止める + Esc で閉じる（FeedbackWidget と同じ作法）。
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

  // ヘッダーは sticky+z-10 で重なり文脈を、backdrop-blur で固定配置の含有ブロックを
  // 作る。ダイアログをその中に置くと、暗幕が viewport ではなくヘッダー内に閉じ込め
  // られてしまう。body 直下へポータルして、ページ全体を確実に覆う。
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={rootRef}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="logout-title"
    >
      {/* 背景の暗幕（クリックで閉じる = キャンセル扱い） */}
      <button
        type="button"
        aria-label="閉じる"
        onClick={onClose}
        className="absolute inset-0 bg-black/40"
      />

      <div className="relative z-10 w-full max-w-sm rounded-2xl bg-surface p-6 shadow-xl">
        <h2 id="logout-title" className="text-base font-semibold text-foreground">
          ログアウトしますか？
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          もう一度使うときは、ログインが必要になります。
        </p>
        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground transition hover:bg-surface-muted"
          >
            いいえ
          </button>
          {/* はい: 確認したうえで実際のサインアウト（Route Handler）へ POST */}
          <form action="/auth/signout" method="post">
            <button
              type="submit"
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary-hover"
            >
              はい
            </button>
          </form>
        </div>
      </div>
    </div>,
    document.body,
  );
}
