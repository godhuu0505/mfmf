"use client";

import { useEffect } from "react";

// ルートレイアウト自体が落ちたときの最後の受け皿（error.tsx では拾えない）。
// html/body を自分で描画する必要があるため、globals.css のトークンに依存しない
// 最小限のスタイルにしている。
export default function GlobalError({
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
    <html lang="ja">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "system-ui, sans-serif",
          padding: "1rem",
        }}
      >
        <main style={{ maxWidth: "24rem" }}>
          <h1 style={{ fontSize: "1.25rem", marginBottom: "0.5rem" }}>
            エラーが発生しました
          </h1>
          <p style={{ fontSize: "0.875rem", marginBottom: "1rem" }}>
            画面を表示できませんでした。時間をおいて再度お試しください。
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              padding: "0.625rem 1.25rem",
              borderRadius: "0.5rem",
              border: "1px solid currentColor",
              background: "transparent",
              font: "inherit",
              cursor: "pointer",
            }}
          >
            もう一度試す
          </button>
          {error.digest && (
            <p style={{ fontSize: "0.75rem", marginTop: "1rem" }}>
              エラー ID: <code>{error.digest}</code>
            </p>
          )}
        </main>
      </body>
    </html>
  );
}
