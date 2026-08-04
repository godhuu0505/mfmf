"use client";

import { useState } from "react";
import { LogOut } from "lucide-react";
import LogoutConfirmDialog from "@/components/LogoutConfirmDialog";

// メニュー画面のログアウト行。AccountMenu と同じ確認ダイアログを挟む（UC-M02）。
export default function MenuLogoutItem() {
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setConfirmOpen(true)}
        className="flex w-full items-center justify-center gap-2 rounded-2xl bg-surface px-4 py-3.5 text-sm font-medium text-red-600 shadow-sm ring-1 ring-border transition hover:bg-surface-muted dark:text-red-400"
      >
        <LogOut className="h-4 w-4" aria-hidden="true" />
        ログアウト
      </button>
      {confirmOpen && (
        <LogoutConfirmDialog onClose={() => setConfirmOpen(false)} />
      )}
    </>
  );
}
