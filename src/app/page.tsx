import Link from "next/link";
import Image from "next/image";
import { createClient } from "@/lib/supabase/server";
import {
  SOURCE_LABEL,
  tagsFromJoin,
  type RecordSource,
  type RecordWithPhotos,
} from "@/types/database";
import {
  buildIlikeOr,
  buildQueryString,
  hasActiveFilters,
  PAGE_SIZE,
  parseFilters,
} from "@/lib/recordQuery";
import { getOwnerTags } from "@/lib/tags";
import { createPhotoSignedUrls } from "@/lib/photos";
import AppHeader from "@/components/AppHeader";
import RecordFilters from "@/components/RecordFilters";

export const dynamic = "force-dynamic";

function formatDate(d: string) {
  const date = new Date(d);
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(date);
}

function excerpt(body: string, max = 80) {
  const oneLine = body.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function SourceBadge({ source }: { source: RecordSource }) {
  const isHome = source === "home";
  return (
    <span
      className={
        "rounded-full px-2 py-0.5 text-xs font-medium " +
        (isHome ? "bg-amber-100 text-amber-700" : "bg-sky-100 text-sky-700")
      }
    >
      {isHome ? "🏠 " : "🏫 "}
      {SOURCE_LABEL[source]}
    </span>
  );
}

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const filters = parseFilters(sp);
  const tagParam = Array.isArray(sp.tag) ? sp.tag[0] : sp.tag;

  const supabase = await createClient();

  // 絞り込み UI 用にオーナーのタグ辞書を取得し、選択中タグを特定する。
  const ownerTags = await getOwnerTags();
  const activeTag = tagParam
    ? ownerTags.find((t) => t.id === tagParam) ?? null
    : null;

  // RLS（owner_id = auth.uid()）の範囲内で検索・絞り込み・並び替え・ページングする。
  // 一覧 + 先頭写真 + 付与タグをまとめて取得。
  let query = supabase
    .from("daycare_records")
    .select("*, record_photos(*), record_tags(tags(id, name))", {
      count: "exact",
    });

  if (filters.source !== "all") query = query.eq("source", filters.source);
  if (filters.from) query = query.gte("record_date", filters.from);
  if (filters.to) query = query.lte("record_date", filters.to);
  if (filters.q) query = query.or(buildIlikeOr(filters.q));

  // タグ絞り込み: 該当タグを持つ記録 id に限定する。
  if (activeTag) {
    const { data: tagged } = await supabase
      .from("record_tags")
      .select("record_id")
      .eq("tag_id", activeTag.id);
    const ids = (tagged ?? []).map((t) => t.record_id);
    // 該当が 0 件なら確実に空にする（in([]) は全件にならないよう注意）。
    query = query.in("id", ids.length > 0 ? ids : [""]);
  }

  switch (filters.sort) {
    case "date_asc":
      query = query
        .order("record_date", { ascending: true })
        .order("created_at", { ascending: true });
      break;
    case "weight_desc":
      query = query
        .order("weight_kg", { ascending: false, nullsFirst: false })
        .order("record_date", { ascending: false });
      break;
    case "weight_asc":
      query = query
        .order("weight_kg", { ascending: true, nullsFirst: false })
        .order("record_date", { ascending: false });
      break;
    default:
      query = query
        .order("record_date", { ascending: false })
        .order("created_at", { ascending: false });
  }

  const fromIdx = (filters.page - 1) * PAGE_SIZE;
  query = query.range(fromIdx, fromIdx + PAGE_SIZE - 1);

  const { data: records, count } = await query.returns<RecordWithPhotos[]>();

  const list = records ?? [];
  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const active = hasActiveFilters(filters) || activeTag != null;

  // タグチップのリンク（現在の検索条件は保ったまま tag だけ切り替え、ページは先頭へ戻す）。
  function tagHref(tagId: string | null): string {
    const qs = buildQueryString(filters, { page: 1 });
    const params = new URLSearchParams(qs.startsWith("?") ? qs.slice(1) : qs);
    if (tagId) params.set("tag", tagId);
    const s = params.toString();
    return s ? `/?${s}` : "/";
  }

  // ページネーションのリンク（選択中タグを保持）。
  function pageHref(page: number): string {
    const qs = buildQueryString(filters, { page });
    const params = new URLSearchParams(qs.startsWith("?") ? qs.slice(1) : qs);
    if (activeTag) params.set("tag", activeTag.id);
    const s = params.toString();
    return s ? `/?${s}` : "/";
  }

  // 各記録の先頭写真サムネに署名付き URL を付与
  const thumbPaths = list
    .map((r) => r.record_photos?.[0]?.storage_path)
    .filter((p): p is string => Boolean(p));

  const urlByPath = await createPhotoSignedUrls(thumbPaths);

  const prevHref = pageHref(filters.page - 1);
  const nextHref = pageHref(filters.page + 1);

  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-2xl px-4 py-6">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-xl font-bold text-slate-900">記録一覧</h1>
          <div className="flex items-center gap-2">
            <Link
              href="/weight"
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
            >
              ⚖️ 体重
            </Link>
            <Link
              href="/records/new"
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-700"
            >
              ＋ 新規
            </Link>
          </div>
        </div>

        {/* key で絞り込み変更時に再マウントし、入力欄を現在の URL 条件に同期する */}
        <RecordFilters
          key={buildQueryString(filters)}
          filters={filters}
          activeTagId={activeTag?.id ?? null}
        />

        {total > 0 && (
          <p className="mb-3 text-sm text-slate-500">
            全 {total} 件
            {totalPages > 1 && (
              <span>
                {" "}
                / {filters.page} ページ目（全 {totalPages} ページ）
              </span>
            )}
          </p>
        )}

        {ownerTags.length > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-1.5">
            {activeTag ? (
              <Link
                href={tagHref(null)}
                className="rounded-full border border-slate-300 px-3 py-0.5 text-xs font-medium text-slate-600 transition hover:bg-slate-100"
              >
                ✕ タグ解除
              </Link>
            ) : (
              <span className="text-xs font-medium text-slate-400">
                タグで絞り込み:
              </span>
            )}
            {ownerTags.map((t) => {
              const isActive = activeTag?.id === t.id;
              return (
                <Link
                  key={t.id}
                  href={isActive ? tagHref(null) : tagHref(t.id)}
                  aria-current={isActive ? "page" : undefined}
                  className={
                    "rounded-full px-2.5 py-0.5 text-xs font-medium transition " +
                    (isActive
                      ? "bg-slate-900 text-white"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200")
                  }
                >
                  #{t.name}
                </Link>
              );
            })}
          </div>
        )}

        {list.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300 p-10 text-center text-slate-500">
            {active ? (
              <>条件に該当する記録はありません。</>
            ) : (
              <>
                まだ記録がありません。
                <br />
                「＋ 新規」から最初の記録を追加しましょう。
              </>
            )}
          </div>
        ) : (
          <ul className="space-y-3">
            {list.map((r) => {
              const thumbPath = r.record_photos?.[0]?.storage_path;
              const thumbUrl = thumbPath ? urlByPath.get(thumbPath) : undefined;
              const photoCount = r.record_photos?.length ?? 0;

              return (
                <li key={r.id}>
                  <Link
                    href={`/records/${r.id}`}
                    className="flex gap-3 rounded-2xl bg-white p-3 shadow-sm ring-1 ring-slate-200 transition hover:ring-slate-300"
                  >
                    <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-xl bg-slate-100">
                      {thumbUrl ? (
                        <Image
                          src={thumbUrl}
                          alt=""
                          fill
                          sizes="80px"
                          className="object-cover"
                          unoptimized
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-2xl">
                          🐾
                        </div>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <SourceBadge source={r.source} />
                        {r.weight_kg != null && (
                          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                            ⚖️ {r.weight_kg}kg
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-sm font-semibold text-slate-900">
                        {formatDate(r.record_date)}
                      </p>
                      <p className="mt-0.5 text-sm text-slate-600">
                        {excerpt(r.body) || "（本文なし）"}
                      </p>
                      {(() => {
                        const recordTags = tagsFromJoin(r.record_tags);
                        return recordTags.length > 0 ? (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {recordTags.map((t) => (
                              <span
                                key={t.id}
                                className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500"
                              >
                                #{t.name}
                              </span>
                            ))}
                          </div>
                        ) : null;
                      })()}
                      {photoCount > 0 && (
                        <p className="mt-1 text-xs text-slate-400">
                          📷 写真 {photoCount} 枚
                        </p>
                      )}
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}

        {totalPages > 1 && (
          <nav className="mt-6 flex items-center justify-between">
            {filters.page > 1 ? (
              <Link
                href={prevHref}
                rel="prev"
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
              >
                ← 前へ
              </Link>
            ) : (
              <span className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-300">
                ← 前へ
              </span>
            )}
            <span className="text-sm text-slate-500">
              {filters.page} / {totalPages}
            </span>
            {filters.page < totalPages ? (
              <Link
                href={nextHref}
                rel="next"
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
              >
                次へ →
              </Link>
            ) : (
              <span className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-300">
                次へ →
              </span>
            )}
          </nav>
        )}
      </main>
    </>
  );
}
