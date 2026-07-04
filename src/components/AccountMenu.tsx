"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { LogOut, MessageSquare, Settings, UserRound } from "lucide-react";

// ヘッダー右側のアカウントアイコン。押下で小さなメニューを開き、
// 「アカウント設定」「送信したフィードバック」「ログアウト」を選べる。
// ログアウトだけは確認ダイアログを挟んでから /auth/signout に POST する。
export default function AccountMenu({
  email,
  displayName,
}: {
  email: string | null;
  displayName: string | null;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // メニュー外のクリック・Esc で閉じる。
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const label = displayName || email || "アカウント";
  const initial = (displayName || email || "").trim().charAt(0).toUpperCase();

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label="アカウントメニュー"
        title="アカウント"
        className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-muted text-sm font-semibold text-foreground ring-1 ring-border transition hover:bg-muted"
      >
        {initial ? (
          <span aria-hidden="true">{initial}</span>
        ) : (
          <UserRound className="h-5 w-5" aria-hidden="true" />
        )}
      </button>

      {menuOpen && (
        <div
          role="menu"
          aria-label="アカウント"
          className="absolute right-0 top-full z-30 mt-2 w-60 overflow-hidden rounded-xl border border-border bg-surface py-1 shadow-lg"
        >
          <div className="border-b border-border px-4 py-3">
            <p className="truncate text-sm font-medium text-foreground">
              {label}
            </p>
            {email && displayName && (
              <p className="truncate text-xs text-muted-foreground">{email}</p>
            )}
          </div>

          <Link
            href="/settings"
            role="menuitem"
            onClick={() => setMenuOpen(false)}
            className="flex items-center gap-2.5 px-4 py-2.5 text-sm text-foreground transition hover:bg-surface-muted"
          >
            <Settings
              className="h-4 w-4 text-muted-foreground"
              aria-hidden="true"
            />
            アカウント設定
          </Link>
          <Link
            href="/feedback"
            role="menuitem"
            onClick={() => setMenuOpen(false)}
            className="flex items-center gap-2.5 px-4 py-2.5 text-sm text-foreground transition hover:bg-surface-muted"
          >
            <MessageSquare
              className="h-4 w-4 text-muted-foreground"
              aria-hidden="true"
            />
            送信したフィードバック
          </Link>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              setConfirmOpen(true);
            }}
            className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-foreground transition hover:bg-surface-muted"
          >
            <LogOut
              className="h-4 w-4 text-muted-foreground"
              aria-hidden="true"
            />
            ログアウト
          </button>
        </div>
      )}

      {confirmOpen && (
        <LogoutConfirmDialog onClose={() => setConfirmOpen(false)} />
      )}
    </div>
  );
}

function LogoutConfirmDialog({ onClose }: { onClose: () => void }) {
  // 背景のスクロールを止める + Esc で閉じる（FeedbackWidget と同じ作法）。
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
  // られ、FeedbackWidget（z-40, body 直下）が上に残ってしまう。body 直下へポータル
  // して、ページ全体を確実に覆う。
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
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
        <h2
          id="logout-title"
          className="text-base font-semibold text-foreground"
        >
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
