"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import {
  buildQueryString,
  hasActiveFilters,
  SORT_KEYS,
  SORT_LABEL,
  type RecordFilters as Filters,
  type RecordSourceFilter,
  type SortKey,
} from "@/lib/recordQuery";

// 記録一覧の検索・絞り込み・並び替えフォーム。
// 記録元はホーム常設のチップ（page.tsx / proto 合意）が受け持ち、
// ここでは hidden で保持だけする（検索してもチップの選択が消えないように）。
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
  // 検索パネルは既定で畳む（UC-H01）。絞り込み中は自動で開く（条件が見えないと
  // 「なぜ一覧が少ないのか」が分からなくなるため）。
  const [openPanel, setOpenPanel] = useState(active);

  return (
    <div className="mb-4">
      <button
        type="button"
        onClick={() => setOpenPanel((v) => !v)}
        aria-expanded={openPanel}
        aria-controls="record-filters-panel"
        className="mb-3 flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground transition hover:bg-surface-muted"
      >
        <Search className="h-4 w-4" aria-hidden="true" />
        検索・絞り込み
        {active && (
          <span
            className="h-1.5 w-1.5 rounded-full bg-primary"
            aria-hidden="true"
          />
        )}
      </button>

      {openPanel && (
    <form
      id="record-filters-panel"
      onSubmit={handleSubmit}
      className="space-y-3 rounded-2xl bg-surface p-3 shadow-sm ring-1 ring-border"
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

      {/* 記録元はホームのチップ選択を維持したまま送る */}
      <input type="hidden" name="source" value={filters.source} />

      {/* 並び替え */}
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
      )}
    </div>
  );
}
