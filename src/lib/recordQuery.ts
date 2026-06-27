// 記録一覧の検索・絞り込み・並び替え条件を URL クエリと相互変換するユーティリティ。
// Server Component（一覧クエリ）とクライアントのフィルタ UI で共通利用する。

import type { RecordSource } from "@/types/database";

export type SortKey = "date_desc" | "date_asc" | "weight_desc" | "weight_asc";

export const SORT_KEYS: SortKey[] = [
  "date_desc",
  "date_asc",
  "weight_desc",
  "weight_asc",
];

export const SORT_LABEL: Record<SortKey, string> = {
  date_desc: "日付（新しい順）",
  date_asc: "日付（古い順）",
  weight_desc: "体重（重い順）",
  weight_asc: "体重（軽い順）",
};

// 1ページあたりの件数
export const PAGE_SIZE = 20;

// 検索文字列の最大長（防御的に制限）
const MAX_QUERY_LENGTH = 100;

export type RecordSourceFilter = "all" | RecordSource;

export type RecordFilters = {
  q: string; // 本文・記入者のキーワード（空文字なら未指定）
  from: string; // 期間 開始日 YYYY-MM-DD（空なら未指定）
  to: string; // 期間 終了日 YYYY-MM-DD（空なら未指定）
  source: RecordSourceFilter;
  sort: SortKey;
  page: number; // 1 始まり
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type SearchParamValue = string | string[] | undefined;

// URL の searchParams から検索条件を取り出す（不正値は安全な既定に丸める）。
export function parseFilters(
  sp: Record<string, SearchParamValue>,
): RecordFilters {
  const get = (key: string): string => {
    const v = sp[key];
    return (Array.isArray(v) ? v[0] : v) ?? "";
  };

  const sourceRaw = get("source");
  const source: RecordSourceFilter =
    sourceRaw === "daycare" || sourceRaw === "home" ? sourceRaw : "all";

  const sortRaw = get("sort");
  const sort: SortKey = (SORT_KEYS as string[]).includes(sortRaw)
    ? (sortRaw as SortKey)
    : "date_desc";

  const fromRaw = get("from");
  const toRaw = get("to");

  const pageNum = Number.parseInt(get("page"), 10);
  const page = Number.isFinite(pageNum) && pageNum > 0 ? pageNum : 1;

  return {
    q: get("q").trim().slice(0, MAX_QUERY_LENGTH),
    from: DATE_RE.test(fromRaw) ? fromRaw : "",
    to: DATE_RE.test(toRaw) ? toRaw : "",
    source,
    sort,
    page,
  };
}

// 既定以外の絞り込みが効いているか（空状態メッセージや「クリア」表示の判定用）。
export function hasActiveFilters(f: RecordFilters): boolean {
  return f.q !== "" || f.from !== "" || f.to !== "" || f.source !== "all";
}

// 現在の条件から URL クエリ文字列（先頭 "?" 付き / 既定値は省略）を作る。
// overrides で一部（主に page）だけ差し替えられる。
export function buildQueryString(
  f: RecordFilters,
  overrides: Partial<RecordFilters> = {},
): string {
  const merged = { ...f, ...overrides };
  const params = new URLSearchParams();
  if (merged.q) params.set("q", merged.q);
  if (merged.from) params.set("from", merged.from);
  if (merged.to) params.set("to", merged.to);
  if (merged.source !== "all") params.set("source", merged.source);
  if (merged.sort !== "date_desc") params.set("sort", merged.sort);
  if (merged.page > 1) params.set("page", String(merged.page));
  const s = params.toString();
  return s ? `?${s}` : "";
}

// PostgREST の or() に渡す ILIKE パターンを組み立てる。
// LIKE ワイルドカード(% _ \)はエスケープし、値はダブルクオートで包んで
// カンマ・括弧などフィルタ構文の特殊文字を無害化する。
export function buildIlikeOr(q: string): string {
  const escaped = q.replace(/([\\%_])/g, "\\$1").replace(/"/g, "");
  return `body.ilike."%${escaped}%",author.ilike."%${escaped}%"`;
}
