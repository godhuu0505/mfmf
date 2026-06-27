"use client";

import { useActionState } from "react";
import {
  updateProfile,
  changePassword,
  type SettingsResult,
} from "@/app/settings/actions";

function ResultMessage({ result }: { result: SettingsResult | null }) {
  if (!result) return null;
  return (
    <p
      role="status"
      className={
        "rounded-lg px-3 py-2 text-sm " +
        (result.ok
          ? "bg-emerald-50 text-emerald-700"
          : "bg-red-50 text-red-600")
      }
    >
      {result.message}
    </p>
  );
}

const inputClass =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-900 outline-none focus:border-slate-500 focus:ring-1 focus:ring-slate-500";

const labelClass = "mb-1 block text-sm font-medium text-slate-700";

const cardClass =
  "space-y-4 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200";

const submitClass =
  "rounded-lg bg-slate-900 px-5 py-2.5 font-medium text-white transition hover:bg-slate-700 disabled:opacity-60";

export function ProfileForm({
  defaultDisplayName,
  defaultAuthor,
}: {
  defaultDisplayName: string;
  defaultAuthor: string;
}) {
  const [result, formAction, pending] = useActionState(updateProfile, null);

  return (
    <form action={formAction} className={cardClass}>
      <div>
        <h2 className="text-base font-bold text-slate-900">プロフィール</h2>
        <p className="mt-0.5 text-sm text-slate-500">
          画面に表示する名前と、記録フォームの「記入者」の初期値を設定できます。
        </p>
      </div>

      <div>
        <label htmlFor="display_name" className={labelClass}>
          表示名
          <span className="ml-1 text-xs font-normal text-slate-400">（任意）</span>
        </label>
        <input
          id="display_name"
          name="display_name"
          type="text"
          defaultValue={defaultDisplayName}
          placeholder="おかあさん など"
          className={inputClass}
        />
      </div>

      <div>
        <label htmlFor="default_author" className={labelClass}>
          記入者の初期値
          <span className="ml-1 text-xs font-normal text-slate-400">（任意）</span>
        </label>
        <input
          id="default_author"
          name="default_author"
          type="text"
          defaultValue={defaultAuthor}
          placeholder="記録を書くときに最初から入る名前"
          className={inputClass}
        />
        <p className="mt-1 text-xs text-slate-400">
          新しい記録を作るとき、この名前が「記入者」欄に最初から入ります。
        </p>
      </div>

      <ResultMessage result={result} />

      <div>
        <button type="submit" disabled={pending} className={submitClass}>
          {pending ? "保存中…" : "保存する"}
        </button>
      </div>
    </form>
  );
}

export function PasswordForm() {
  const [result, formAction, pending] = useActionState(changePassword, null);

  return (
    <form action={formAction} className={cardClass}>
      <div>
        <h2 className="text-base font-bold text-slate-900">パスワードの変更</h2>
        <p className="mt-0.5 text-sm text-slate-500">
          8 文字以上で、新しいパスワードを 2 回入力してください。
        </p>
      </div>

      <div>
        <label htmlFor="password" className={labelClass}>
          新しいパスワード
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          className={inputClass}
        />
      </div>

      <div>
        <label htmlFor="password_confirm" className={labelClass}>
          新しいパスワード（確認）
        </label>
        <input
          id="password_confirm"
          name="password_confirm"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          className={inputClass}
        />
      </div>

      <ResultMessage result={result} />

      <div>
        <button type="submit" disabled={pending} className={submitClass}>
          {pending ? "変更中…" : "パスワードを変更する"}
        </button>
      </div>
    </form>
  );
}
