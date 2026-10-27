"use client";

import { useState } from "react";
import { Copy } from "lucide-react";

export default function CareSummaryCopyButton({ text }: { text: string }) {
  const [status, setStatus] = useState<"idle" | "copying" | "copied" | "error">("idle");

  async function copy() {
    setStatus("copying");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(text);
      setStatus("copied");
    } catch {
      setStatus("error");
    }
  }

  return (
    <div className="space-y-2 print:hidden">
      <button type="button" onClick={copy} disabled={status === "copying"} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-border bg-surface px-4 font-semibold hover:bg-surface-muted disabled:opacity-50">
        <Copy size={18} aria-hidden="true" />{status === "copying" ? "コピー中…" : "テキストをコピー"}
      </button>
      <p role={status === "error" ? "alert" : "status"} aria-atomic="true" className="text-xs leading-relaxed text-muted-foreground">
        {status === "copied" ? "コピーしました。渡す相手に必要な情報か確認してから貼り付けてください。"
          : status === "error" ? "コピーできませんでした。ブラウザの設定を確認するか、印刷・PDF保存をご利用ください。"
            : "このシートの内容を、メッセージなどに貼り付けられます。"}
      </p>
    </div>
  );
}
