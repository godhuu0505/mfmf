"use client";

import { useFormStatus } from "react-dom";

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg bg-slate-900 px-5 py-2.5 font-medium text-white transition hover:bg-slate-700 disabled:opacity-60"
    >
      {pending ? "保存中…" : label}
    </button>
  );
}

type Props = {
  action: (formData: FormData) => void | Promise<void>;
  defaultDate: string; // YYYY-MM-DD
  defaultBody?: string;
  submitLabel: string;
  cancelHref: string;
};

export default function RecordForm({
  action,
  defaultDate,
  defaultBody = "",
  submitLabel,
  cancelHref,
}: Props) {
  return (
    <form action={action} className="space-y-5">
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

      <div>
        <label
          htmlFor="body"
          className="mb-1 block text-sm font-medium text-slate-700"
        >
          保育園からの記録
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
          id="photos"
          name="photos"
          type="file"
          accept="image/*"
          multiple
          className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-4 file:py-2 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-200"
        />
      </div>

      <div className="flex items-center gap-3 pt-2">
        <SubmitButton label={submitLabel} />
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
