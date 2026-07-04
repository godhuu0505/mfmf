"use client";

import Link from "next/link";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

const inputClass =
  "w-full rounded-lg border border-border px-3 py-2 text-foreground outline-none focus:border-muted-foreground focus:ring-1 focus:ring-muted-foreground";

// パスワード再設定メールの送信（UC-O02 の付随フロー）。
// 登録の有無を画面から判別させないため、結果は常に「送信しました」を表示する。
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);

    const supabase = createClient();
    // 再設定リンク → /auth/callback で code をセッションへ交換 → /reset-password。
    await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
    });

    // エラー（未登録・レート制限等）でも同じ表示（メールアドレス列挙防止）。
    setSent(true);
    setLoading(false);
  }

  return (
    <main id="main" className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="mb-8 text-center text-2xl font-bold text-foreground">
          パスワードの再設定
        </h1>

        <div className="space-y-4 rounded-2xl bg-surface p-6 shadow-sm ring-1 ring-border">
          {sent ? (
            <>
              <p className="text-sm text-foreground">
                入力されたメールアドレスが登録されている場合、パスワード再設定用の
                リンクを送信しました。メール内のリンクから新しいパスワードを設定
                してください。
              </p>
              <p className="text-xs text-muted-foreground">
                届かない場合は迷惑メールフォルダーを確認してください。
              </p>
            </>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-3">
              <div>
                <label
                  htmlFor="email"
                  className="mb-1 block text-sm font-medium text-foreground"
                >
                  登録済みのメールアドレス
                </label>
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={inputClass}
                />
              </div>
              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-lg bg-primary px-4 py-2.5 font-medium text-primary-foreground transition hover:bg-primary-hover disabled:opacity-60"
              >
                {loading ? "送信中…" : "再設定メールを送信"}
              </button>
            </form>
          )}

          <p className="text-center text-xs">
            <Link
              href="/login"
              className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              ログインへ戻る
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}
