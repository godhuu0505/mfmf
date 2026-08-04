"use client";

import { useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

// 招待リンクなどの相対パスを絶対 URL にしてクリップボードへコピーする。
// 失敗したときはその旨を表示し（成功と偽らない）、選択してコピーできる
// URL 入力欄を出す —— Clipboard API が使えない WebView 等でもリンクを
// 受け渡せる最後の手段を残す。
export default function CopyLinkButton({ path }: { path: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  // 失敗時に表示する絶対 URL（クライアントでのみ確定する）
  const [failedUrl, setFailedUrl] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function copy() {
    const url = `${window.location.origin}${path}`;
    if (timer.current) clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(url);
      setState("copied");
      setFailedUrl("");
      timer.current = setTimeout(() => setState("idle"), 1800);
    } catch {
      // 失敗表示は自動で消さない（出した URL が選択中に消えないように）
      setState("failed");
      setFailedUrl(url);
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        onClick={copy}
        className="inline-flex items-center gap-1 rounded-lg border border-border bg-surface px-2.5 py-1 text-xs font-medium text-foreground transition hover:bg-surface-muted"
      >
        {state === "copied" ? (
          <>
            <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
            コピーしました
          </>
        ) : state === "failed" ? (
          <>コピーできませんでした</>
        ) : (
          <>
            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            リンクをコピー
          </>
        )}
      </button>
      {state === "failed" && failedUrl && (
        <input
          readOnly
          value={failedUrl}
          aria-label="招待リンクの URL（選択してコピーしてください）"
          onFocus={(e) => e.currentTarget.select()}
          className="w-56 max-w-full rounded-lg border border-border bg-surface px-2 py-1 text-xs text-foreground"
        />
      )}
    </span>
  );
}
