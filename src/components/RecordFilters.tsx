"use client";

import { useRouter } from "next/navigation";
import {
  buildQueryString,
  hasActiveFilters,
  SORT_KEYS,
  SORT_LABEL,
  type RecordFilters as Filters,
  type RecordSourceFilter,
  type SortKey,
} from "@/lib/recordQuery";

const SOURCE_OPTIONS: { value: RecordSourceFilter; label: string }[] = [
  { value: "all", label: "すべて" },
  { value: "daycare", label: "🏫 保育園" },
  { value: "home", label: "🏠 おうち" },
];

// 記録一覧の検索・絞り込み・並び替えフォーム。
// 送信時に空欄・既定値を除いた URL を組み立てて遷移するため、
// 共有・リロードで同じ結果を再現できる（条件は URL クエリが正）。
export default function RecordFilters({ filters }: { filters: Filters }) {
  const router = useRouter();

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const sourceRaw = String(fd.get("source") || "all");
    const source: RecordSourceFilter =
      sourceRaw === "daycare" || sourceRaw === "home" ? sourceRaw : "all";
    const sortRaw = String(fd.get("sort") || "date_desc");
    const sort: SortKey = (SORT_KEYS as string[]).includes(sortRaw)
      ? (sortRaw as SortKey)
      : "date_desc";

    // 絞り込みを変えたら 1 ページ目へ戻す
    const next: Filters = {
      q: String(fd.get("q") || "").trim(),
      from: String(fd.get("from") || ""),
      to: String(fd.get("to") || ""),
      source,
      sort,
      page: 1,
    };
    router.push(`/${buildQueryString(next)}`);
  }

  const active = hasActiveFilters(filters);

  return (
    <form
      onSubmit={handleSubmit}
      className="mb-4 space-y-3 rounded-2xl bg-white p-3 shadow-sm ring-1 ring-slate-200"
    >
      {/* キーワード検索 */}
      <div className="flex gap-2">
        <input
          type="search"
          name="q"
          defaultValue={filters.q}
          placeholder="本文・記入者で検索"
          className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-500 focus:outline-none"
        />
        <button
          type="submit"
          className="shrink-0 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-700"
        >
          検索
        </button>
      </div>

      {/* 記録元 / 並び替え */}
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-500">
            記録元
          </span>
          <select
            name="source"
            defaultValue={filters.source}
            className="w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm text-slate-900 focus:border-slate-500 focus:outline-none"
          >
            {SOURCE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-500">
            並び替え
          </span>
          <select
            name="sort"
            defaultValue={filters.sort}
            className="w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm text-slate-900 focus:border-slate-500 focus:outline-none"
          >
            {SORT_KEYS.map((k) => (
              <option key={k} value={k}>
                {SORT_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* 期間 */}
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-500">
            開始日
          </span>
          <input
            type="date"
            name="from"
            defaultValue={filters.from}
            max={filters.to || undefined}
            className="w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm text-slate-900 focus:border-slate-500 focus:outline-none"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-500">
            終了日
          </span>
          <input
            type="date"
            name="to"
            defaultValue={filters.to}
            min={filters.from || undefined}
            className="w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm text-slate-900 focus:border-slate-500 focus:outline-none"
          />
        </label>
      </div>

      {active && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => router.push("/")}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
          >
            条件をクリア
          </button>
        </div>
      )}
    </form>
  );
}
