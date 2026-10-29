"use client";

import { useRef, useState } from "react";
import { Copy } from "lucide-react";

export default function CareSummaryCopyButton({ text }: { text: string }) {
  const pending = useRef(false);
  const [copying, setCopying] = useState(false);
  const [result, setResult] = useState<{ text: string; status: "copied" | "error" } | null>(null);
  // クライアント遷移後も進行中の書き込みを待つ。完了表示はコピーした本文だけに出す。
  const status = result?.text === text ? result.status : "idle";

  async function copy() {
    // React の再描画より前の連打も、同じ本文への2回目の書き込みにしない。
    if (pending.current) return;
    pending.current = true;
    setCopying(true);
    setResult(null);
    const copiedText = text;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(copiedText);
      setResult({ text: copiedText, status: "copied" });
    } catch {
      setResult({ text: copiedText, status: "error" });
    } finally {
      pending.current = false;
      setCopying(false);
    }
  }

  return (
    <div className="space-y-2 print:hidden">
      <button type="button" onClick={copy} disabled={copying} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-border bg-surface px-4 font-semibold hover:bg-surface-muted disabled:opacity-50">
        <Copy size={18} aria-hidden="true" />{copying ? "コピー中…" : "テキストをコピー"}
      </button>
      <p role={status === "error" ? "alert" : "status"} aria-atomic="true" className="text-xs leading-relaxed text-muted-foreground">
        {status === "copied" ? "コピーしました。渡す相手に必要な情報か確認してから貼り付けてください。"
          : status === "error" ? "コピーできませんでした。ブラウザの設定を確認するか、印刷・PDF保存をご利用ください。"
            : "このシートの内容を、メッセージなどに貼り付けられます。"}
      </p>
    </div>
  );
}
