"use client";

import { useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { resizeImages } from "@/lib/imageResize";
import { RECORD_SOURCES, SOURCE_LABEL, type RecordSource } from "@/types/database";

function SubmitButton({ label, disabled }: { label: string; disabled?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || disabled}
      className="rounded-lg bg-slate-900 px-5 py-2.5 font-medium text-white transition hover:bg-slate-700 disabled:opacity-60"
    >
      {pending ? "保存中…" : label}
    </button>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

type Props = {
  action: (formData: FormData) => void | Promise<void>;
  defaultDate: string; // YYYY-MM-DD
  defaultBody?: string;
  defaultSource?: RecordSource;
  defaultAuthor?: string;
  defaultWeightKg?: number | null;
  submitLabel: string;
  cancelHref: string;
};

export default function RecordForm({
  action,
  defaultDate,
  defaultBody = "",
  defaultSource = "daycare",
  defaultAuthor = "",
  defaultWeightKg = null,
  submitLabel,
  cancelHref,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [processing, setProcessing] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [source, setSource] = useState<RecordSource>(defaultSource);

  // 選択された画像をアップロード前に縮小・圧縮し、input.files を差し替える。
  async function handleFilesChange(e: React.ChangeEvent<HTMLInputElement>) {
    const input = e.currentTarget;
    const selected = Array.from(input.files ?? []);
    if (selected.length === 0) {
      setSummary(null);
      return;
    }

    setProcessing(true);
    setSummary(null);
    try {
      const before = selected.reduce((sum, f) => sum + f.size, 0);
      const resized = await resizeImages(selected);
      const after = resized.reduce((sum, f) => sum + f.size, 0);

      // 圧縮後のファイルを input に戻す（フォーム送信でそのまま使われる）
      const dt = new DataTransfer();
      resized.forEach((f) => dt.items.add(f));
      if (fileInputRef.current) fileInputRef.current.files = dt.files;

      const saved = before > 0 ? Math.round((1 - after / before) * 100) : 0;
      setSummary(
        `${resized.length}枚を最適化しました（${formatBytes(before)} → ${formatBytes(after)}` +
          (saved > 0 ? ` / -${saved}%` : "") +
          "）",
      );
    } catch {
      // 失敗しても元の選択ファイルで送信できるので致命的ではない
      setSummary("画像の最適化をスキップしました（そのままアップロードします）");
    } finally {
      setProcessing(false);
    }
  }

  return (
    <form action={action} className="space-y-5">
      <div>
        <span className="mb-1 block text-sm font-medium text-slate-700">
          記録元
        </span>
        <input type="hidden" name="source" value={source} />
        <div className="inline-flex rounded-lg border border-slate-300 p-0.5">
          {RECORD_SOURCES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSource(s)}
              aria-pressed={source === s}
              className={
                "rounded-md px-4 py-1.5 text-sm font-medium transition " +
                (source === s
                  ? "bg-slate-900 text-white"
                  : "text-slate-600 hover:bg-slate-100")
              }
            >
              {SOURCE_LABEL[s]}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label
          htmlFor="record_date"
          className="mb-1 block text-sm font-medium text-slate-700"
        >
          記録の日付
        </label>
        <input
          id="record_date"
          name="record_date"
          type="date"
          required
          defaultValue={defaultDate}
          className="rounded-lg border border-slate-300 px-3 py-2 text-slate-900 outline-none focus:border-slate-500 focus:ring-1 focus:ring-slate-500"
        />
      </div>

      <div className="flex flex-wrap gap-4">
        <div className="flex-1 min-w-[10rem]">
          <label
            htmlFor="author"
            className="mb-1 block text-sm font-medium text-slate-700"
          >
            記入者
            <span className="ml-1 text-xs font-normal text-slate-400">
              （任意）
            </span>
          </label>
          <input
            id="author"
            name="author"
            type="text"
            defaultValue={defaultAuthor}
            placeholder={source === "home" ? "おかあさん など" : "担当スタッフ名"}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-900 outline-none focus:border-slate-500 focus:ring-1 focus:ring-slate-500"
          />
        </div>
        <div className="w-32">
          <label
            htmlFor="weight_kg"
            className="mb-1 block text-sm font-medium text-slate-700"
          >
            体重(kg)
            <span className="ml-1 text-xs font-normal text-slate-400">
              （任意）
            </span>
          </label>
          <input
            id="weight_kg"
            name="weight_kg"
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            defaultValue={defaultWeightKg ?? ""}
            placeholder="2.25"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-900 outline-none focus:border-slate-500 focus:ring-1 focus:ring-slate-500"
          />
        </div>
      </div>

      <div>
        <label
          htmlFor="body"
          className="mb-1 block text-sm font-medium text-slate-700"
        >
          {source === "home" ? "おうちでの記録" : "保育園からの記録"}
        </label>
        <textarea
          id="body"
          name="body"
          rows={8}
          defaultValue={defaultBody}
          placeholder="今日の様子などを記録します"
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-900 outline-none focus:border-slate-500 focus:ring-1 focus:ring-slate-500"
        />
      </div>

      <div>
        <label
          htmlFor="photos"
          className="mb-1 block text-sm font-medium text-slate-700"
        >
          写真を追加（複数選択可）
        </label>
        <input
          ref={fileInputRef}
          id="photos"
          name="photos"
          type="file"
          accept="image/*"
          multiple
          onChange={handleFilesChange}
          className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-4 file:py-2 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-200"
        />
        <p className="mt-1.5 text-xs text-slate-400" aria-live="polite">
          {processing
            ? "画像を最適化しています…"
            : summary ?? "アップロード時に自動で縮小・圧縮します（長辺 1600px）。"}
        </p>
      </div>

      <div className="flex items-center gap-3 pt-2">
        <SubmitButton label={submitLabel} disabled={processing} />
        <a
          href={cancelHref}
          className="text-sm text-slate-500 transition hover:text-slate-800"
        >
          キャンセル
        </a>
      </div>
    </form>
  );
}
