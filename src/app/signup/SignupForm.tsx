"use client";

import Link from "next/link";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

const inputClass =
  "w-full rounded-lg border border-border px-3 py-2 text-foreground outline-none focus:border-muted-foreground focus:ring-1 focus:ring-muted-foreground";

// Supabase Auth のエラーメッセージ（英語）をユーザー向けの日本語へ寄せる。
function signupErrorMessage(message: string): string {
  if (message.includes("Password should be at least")) {
    return "パスワードが短すぎます。8文字以上で設定してください。";
  }
  if (message.toLowerCase().includes("rate limit")) {
    return "しばらく時間をおいてから再度お試しください。";
  }
  return "登録に失敗しました。時間をおいて再度お試しください。";
}

// UC-O02（D3）: email/password でのセルフ登録。メール確認を伴う。
// UC-O06: 利用規約・プライバシーへの同意を必須にし、同意時刻を user_metadata に残す
//（正式な文書・同意台帳は #50 法務で整備。それまで本画面は flag で閉塞 UC-O08）。
export default function SignupForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
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
    if (!agreed) {
      setError("利用規約・プライバシーポリシーへの同意が必要です。");
      return;
    }

    setLoading(true);
    const supabase = createClient();
    const { data, error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
        // UC-O06: 同意時刻の記録（正式な同意台帳は #50 で DB 化を検討）
        data: { tos_accepted_at: new Date().toISOString() },
      },
    });

    if (error) {
      setError(signupErrorMessage(error.message));
      setLoading(false);
      return;
    }

    // メール確認が無効な環境（ローカル既定）では即セッションが返る。
    if (data.session) {
      window.location.assign("/");
      return;
    }

    // メール確認あり。既存メールアドレスの場合も Supabase は成功様の応答を返す
    //（identities が空）ため、登録済みかどうかを画面から判別させない（列挙防止）。
    setSent(true);
    setLoading(false);
  }

  if (sent) {
    return (
      <div className="space-y-4 rounded-2xl bg-surface p-6 shadow-sm ring-1 ring-border">
        <h2 className="text-base font-bold text-foreground">
          確認メールを送信しました
        </h2>
        <p className="text-sm text-muted-foreground">
          {email.trim()} 宛てに確認メールを送りました。メール内のリンクを開くと
          登録が完了し、そのまま利用を開始できます。
        </p>
        <p className="text-xs text-muted-foreground">
          届かない場合は迷惑メールフォルダーを確認してください。
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-2xl bg-surface p-6 shadow-sm ring-1 ring-border">
      <h2 className="text-base font-bold text-foreground">アカウント作成</h2>

      {error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600" role="alert">
          {error}
        </p>
      )}

      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label htmlFor="email" className="mb-1 block text-sm font-medium text-foreground">
            メールアドレス
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
        <div>
          <label htmlFor="password" className="mb-1 block text-sm font-medium text-foreground">
            パスワード
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
            パスワード（確認）
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

        <label className="flex items-start gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            className="mt-0.5"
            required
          />
          <span>
            <Link
              href="/terms"
              target="_blank"
              className="text-foreground underline underline-offset-2 hover:text-foreground"
            >
              利用規約
            </Link>
            ・
            <Link
              href="/privacy"
              target="_blank"
              className="text-foreground underline underline-offset-2 hover:text-foreground"
            >
              プライバシーポリシー
            </Link>
            に同意します
          </span>
        </label>

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg bg-primary px-4 py-2.5 font-medium text-primary-foreground transition hover:bg-primary-hover disabled:opacity-60"
        >
          {loading ? "登録中…" : "登録する"}
        </button>
      </form>

      <p className="text-center text-xs text-muted-foreground">
        すでにアカウントをお持ちの方は{" "}
        <Link
          href="/login"
          className="font-medium text-foreground underline-offset-2 hover:underline"
        >
          ログイン
        </Link>
      </p>
    </div>
  );
}
