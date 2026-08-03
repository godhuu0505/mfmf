"use client";

import { useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

// 招待リンクなどの相対パスを絶対 URL にしてクリップボードへコピーする。
// 失敗したときはその旨を表示する（成功と偽らない）。
export default function CopyLinkButton({ path }: { path: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function copy() {
    const url = `${window.location.origin}${path}`;
    try {
      await navigator.clipboard.writeText(url);
      setState("copied");
    } catch {
      setState("failed");
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 1800);
  }

  return (
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
  );
}
