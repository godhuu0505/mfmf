"use client";

import Link from "next/link";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

const inputClass =
  "w-full rounded-lg border border-border px-3 py-2 text-foreground outline-none focus:border-muted-foreground focus:ring-1 focus:ring-muted-foreground";

// 新しいパスワードの設定。再設定メールのリンク（/auth/callback?next=/reset-password）
// で確立した回復セッションを前提に updateUser で更新する。
export default function ResetPasswordPage() {
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError("パスワードは8文字以上で設定してください。");
      return;
    }
    if (password !== passwordConfirm) {
      setError("確認用のパスワードが一致しません。");
      return;
    }

    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ password });

    if (error) {
      setError(
        error.message.includes("should be different")
          ? "現在と同じパスワードは設定できません。"
          : "パスワードの更新に失敗しました。再設定メールのリンクを開き直してください。",
      );
      setLoading(false);
      return;
    }

    window.location.assign("/");
  }

  return (
    <main id="main" className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="mb-8 text-center text-2xl font-bold text-foreground">
          新しいパスワードを設定
        </h1>

        <div className="space-y-4 rounded-2xl bg-surface p-6 shadow-sm ring-1 ring-border">
          {error && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600" role="alert">
              {error}
            </p>
          )}

          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label
                htmlFor="password"
                className="mb-1 block text-sm font-medium text-foreground"
              >
                新しいパスワード
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  （8文字以上）
                </span>
              </label>
              <input
                id="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={inputClass}
              />
            </div>
            <div>
              <label
                htmlFor="password_confirm"
                className="mb-1 block text-sm font-medium text-foreground"
              >
                新しいパスワード（確認）
              </label>
              <input
                id="password_confirm"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={passwordConfirm}
                onChange={(e) => setPasswordConfirm(e.target.value)}
                className={inputClass}
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg bg-primary px-4 py-2.5 font-medium text-primary-foreground transition hover:bg-primary-hover disabled:opacity-60"
            >
              {loading ? "更新中…" : "パスワードを更新"}
            </button>
          </form>

          <p className="text-center text-xs">
            <Link
              href="/"
              className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              ホームへ戻る
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}
