"use client";

import Link from "next/link";
import { useEffect } from "react";

// アプリ全体のエラーバウンダリ。
// これが無いと、Server Component / Server Action が投げた例外で画面全体が
// Next の素の「Application error: a server-side exception has occurred」に
// 置き換わり、ユーザーは何が起きたか分からないまま行き止まりになる
// （招待受諾で実際に発生した）。サーバ側の詳細は Sentry（onRequestError）と
// Vercel のログに残るので、ここでは digest だけ出して問い合わせに使えるようにする。
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main
      id="main"
      className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-4 py-10"
    >
      <h1 className="text-xl font-bold text-foreground">
        エラーが発生しました
      </h1>
      <p className="text-sm text-muted-foreground">
        処理を完了できませんでした。時間をおいて再度お試しください。
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={reset}
          className="rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition hover:bg-primary-hover"
        >
          もう一度試す
        </button>
        <Link
          href="/"
          className="rounded-lg border border-border px-4 py-2.5 text-sm font-medium text-foreground transition hover:bg-surface-muted"
        >
          ホームへ戻る
        </Link>
      </div>
      {error.digest && (
        <p className="text-xs text-muted-foreground">
          エラー ID: <code>{error.digest}</code>
        </p>
      )}
    </main>
  );
}
