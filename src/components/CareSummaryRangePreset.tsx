"use client";

export default function CareSummaryRangePreset({ label, from, to }: { label: string; from: string; to: string }) {
  return (
    <button type="button" className="rounded-full border border-border px-3 py-2 hover:bg-surface-muted" onClick={(event) => {
      const form = event.currentTarget.form;
      const fromInput = form?.elements.namedItem("from");
      const toInput = form?.elements.namedItem("to");
      if (!form || !(fromInput instanceof HTMLInputElement) || !(toInput instanceof HTMLInputElement)) return;
      // 未送信のペット選択を含む現在のフォームを、通常の必須入力検証付きで送る。
      fromInput.value = from;
      toInput.value = to;
      form.requestSubmit();
    }}>
      {label}
    </button>
  );
}
