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
export default function RecordFilters({
  filters,
  activeTagId = null,
}: {
  filters: Filters;
  /** 選択中のタグ id（検索条件を変えても保持する）。 */
  activeTagId?: string | null;
}) {
  const router = useRouter();

  // buildQueryString の結果に選択中タグを足してから遷移する。
  function pushWithTag(qs: string) {
    if (!activeTagId) {
      router.push(`/${qs}`);
      return;
    }
    const params = new URLSearchParams(qs.startsWith("?") ? qs.slice(1) : qs);
    params.set("tag", activeTagId);
    router.push(`/?${params.toString()}`);
  }

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
    pushWithTag(buildQueryString(next));
  }

  const active = hasActiveFilters(filters);

  return (
    <form
      onSubmit={handleSubmit}
      className="mb-4 space-y-3 rounded-2xl bg-surface p-3 shadow-sm ring-1 ring-border"
    >
      {/* キーワード検索 */}
      <div className="flex gap-2">
        <input
          type="search"
          name="q"
          defaultValue={filters.q}
          placeholder="本文・記入者で検索"
          className="min-w-0 flex-1 rounded-lg border border-border px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-muted-foreground focus:outline-none"
        />
        <button
          type="submit"
          className="shrink-0 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary-hover"
        >
          検索
        </button>
      </div>

      {/* 記録元 / 並び替え */}
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">
            記録元
          </span>
          <select
            name="source"
            defaultValue={filters.source}
            className="w-full rounded-lg border border-border bg-surface px-2 py-2 text-sm text-foreground focus:border-muted-foreground focus:outline-none"
          >
            {SOURCE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">
            並び替え
          </span>
          <select
            name="sort"
            defaultValue={filters.sort}
            className="w-full rounded-lg border border-border bg-surface px-2 py-2 text-sm text-foreground focus:border-muted-foreground focus:outline-none"
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
          <span className="mb-1 block text-xs font-medium text-muted-foreground">
            開始日
          </span>
          <input
            type="date"
            name="from"
            defaultValue={filters.from}
            max={filters.to || undefined}
            className="w-full rounded-lg border border-border bg-surface px-2 py-2 text-sm text-foreground focus:border-muted-foreground focus:outline-none"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">
            終了日
          </span>
          <input
            type="date"
            name="to"
            defaultValue={filters.to}
            min={filters.from || undefined}
            className="w-full rounded-lg border border-border bg-surface px-2 py-2 text-sm text-foreground focus:border-muted-foreground focus:outline-none"
          />
        </label>
      </div>

      {active && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => pushWithTag("")}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-muted-foreground transition hover:bg-surface-muted hover:text-foreground"
          >
            条件をクリア
          </button>
        </div>
      )}
    </form>
  );
}
