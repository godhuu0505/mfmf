"use client";

import { Printer } from "lucide-react";

export default function CareSummaryPrintButton() {
  return (
    <div className="space-y-2 print:hidden">
      <button type="button" onClick={() => window.print()} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 font-semibold text-primary-foreground hover:bg-primary-hover">
        <Printer aria-hidden="true" className="h-5 w-5" />
        印刷・PDF保存
      </button>
      <p className="text-center text-xs text-muted-foreground">端末の印刷画面が開きます。PDF保存の可否は端末によって異なります。</p>
    </div>
  );
}
