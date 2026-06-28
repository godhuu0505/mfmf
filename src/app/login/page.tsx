"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

// Drive 連携のため drive.file スコープを要求する。
// drive.file は「アプリが作成・選択したファイルのみ」アクセスでき、
// Google の OAuth 監査（センシティブスコープ審査）の対象外。
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

const ERROR_MESSAGES: Record<string, string> = {
  oauth: "ログインに失敗しました。時間をおいて再度お試しください。",
  drive: "Google Drive との連携に失敗しました。もう一度ログインしてください。",
};

export default function LoginPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // コールバックから ?error=... で戻ってきた場合のメッセージ表示
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("error");
    if (code) {
      setError(ERROR_MESSAGES[code] ?? ERROR_MESSAGES.oauth);
    }
  }, []);

  async function signInWithGoogle() {
    setLoading(true);
    setError(null);

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
        scopes: DRIVE_SCOPE,
        // refresh token を確実に得るため offline + 毎回 consent
        queryParams: { access_type: "offline", prompt: "consent" },
      },
    });

    if (error) {
      setError(ERROR_MESSAGES.oauth);
      setLoading(false);
    }
    // 成功時は Google の同意画面へリダイレクトされる
  }

  return (
    <main id="main" className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-center text-2xl font-bold text-foreground">
          mfmf
        </h1>
        <p className="mb-8 text-center text-sm text-muted-foreground">
          ペット保育園記録
        </p>

        <div className="space-y-4 rounded-2xl bg-surface p-6 shadow-sm ring-1 ring-border">
          {error && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">
              {error}
            </p>
          )}

          <button
            type="button"
            onClick={signInWithGoogle}
            disabled={loading}
            className="flex w-full items-center justify-center gap-3 rounded-lg border border-border bg-surface px-4 py-2.5 font-medium text-foreground transition hover:bg-surface-muted disabled:opacity-60"
          >
            <GoogleIcon />
            {loading ? "ログイン中…" : "Google でログイン"}
          </button>

          <p className="text-center text-xs text-muted-foreground">
            写真は Google Drive に保存されます。
          </p>
        </div>
      </div>
    </main>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.71-1.57 2.68-3.89 2.68-6.62z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72a5.41 5.41 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"
      />
    </svg>
  );
}
