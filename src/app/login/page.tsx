"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(
    searchParams.get("error") === "oauth"
      ? "Google ログインに失敗しました。もう一度お試しください。"
      : null,
  );
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      setError("メールアドレスまたはパスワードが正しくありません。");
      setLoading(false);
      return;
    }

    // セッション Cookie 反映のため refresh しつつ一覧へ
    router.replace("/");
    router.refresh();
  }

  async function handleGoogleSignIn() {
    setError(null);
    setGoogleLoading(true);

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    if (error) {
      setError("Google ログインを開始できませんでした。");
      setGoogleLoading(false);
    }
    // 成功時はブラウザが Google の同意画面へ遷移する。
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-center text-2xl font-bold text-slate-900">
          mfmf
        </h1>
        <p className="mb-8 text-center text-sm text-slate-500">
          ペット保育園記録
        </p>

        <div className="space-y-4 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="email"
                className="mb-1 block text-sm font-medium text-slate-700"
              >
                メールアドレス
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-900 outline-none focus:border-slate-500 focus:ring-1 focus:ring-slate-500"
              />
            </div>

            <div>
              <label
                htmlFor="password"
                className="mb-1 block text-sm font-medium text-slate-700"
              >
                パスワード
              </label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-900 outline-none focus:border-slate-500 focus:ring-1 focus:ring-slate-500"
              />
            </div>

            <button
              type="submit"
              disabled={loading || googleLoading}
              className="w-full rounded-lg bg-slate-900 px-4 py-2.5 font-medium text-white transition hover:bg-slate-700 disabled:opacity-60"
            >
              {loading ? "ログイン中…" : "ログイン"}
            </button>
          </form>

          <div className="flex items-center gap-3" aria-hidden="true">
            <span className="h-px flex-1 bg-slate-200" />
            <span className="text-xs text-slate-400">または</span>
            <span className="h-px flex-1 bg-slate-200" />
          </div>

          <button
            type="button"
            onClick={handleGoogleSignIn}
            disabled={loading || googleLoading}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
          >
            <svg
              className="h-5 w-5"
              viewBox="0 0 24 24"
              aria-hidden="true"
              focusable="false"
            >
              <path
                fill="#4285F4"
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.56c2.08-1.92 3.28-4.74 3.28-8.09Z"
              />
              <path
                fill="#34A853"
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.56-2.76c-.98.66-2.23 1.06-3.72 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z"
              />
              <path
                fill="#FBBC05"
                d="M5.84 14.11a6.6 6.6 0 0 1 0-4.22V7.05H2.18a11 11 0 0 0 0 9.9l3.66-2.84Z"
              />
              <path
                fill="#EA4335"
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.05l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38Z"
              />
            </svg>
            {googleLoading ? "リダイレクト中…" : "Google で続行"}
          </button>

          {error && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">
              {error}
            </p>
          )}
        </div>

        <p className="mt-4 text-center text-xs text-slate-400">
          アカウントは管理者が発行します。
          <br />
          Google ログインは、ご夫婦で共有する 1 つの Google アカウントでご利用ください。
        </p>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
