import Link from "next/link";
import Image from "next/image";
import { redirect } from "next/navigation";
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
import { getTagDictionary } from "@/lib/tags";
import { canEdit, getCurrentMembership, householdScopeFilter } from "@/lib/household";
import { hasActiveGuestGrant } from "@/lib/guest";
import { createPhotoSignedUrls } from "@/lib/photos";
import RecordFilters from "@/components/RecordFilters";
import SourceIcon from "@/components/SourceIcon";
import { Camera, PawPrint, Scale, X } from "lucide-react";

export const dynamic = "force-dynamic";

// Asia/Tokyo の今日/昨日（YYYY-MM-DD）。サーバーの実行 TZ に依存させない。
function jstDateISO(offsetDays = 0): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(
    new Date(Date.now() + offsetDays * 86_400_000),
  );
}

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
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium " +
        (isHome ? "bg-amber-100 text-amber-900" : "bg-sky-100 text-sky-900")
      }
    >
      <SourceIcon source={source} className="h-3.5 w-3.5" />
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
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // 絞り込み UI 用に世帯のタグ辞書を取得し、選択中タグを特定する。
  const dictionaryTags = await getTagDictionary();
  const activeTag = tagParam
    ? dictionaryTags.find((t) => t.id === tagParam) ?? null
    : null;

  // 読み取りは household 基準へ寄せる（Phase 3.5 S1 手順7）。所属世帯を解決できれば
  // household_id で絞り込み、未所属なら従来どおり owner_id RLS にフォールバックする。
  // いずれも RLS（owner_id = auth.uid() / household メンバー）が一次防衛線。
  const membership = await getCurrentMembership(supabase);
  // 世帯を持たないユーザー: 有効なゲスト付与があればゲスト画面へ（UC-G02）。
  // それ以外（新規登録直後など）はオンボーディングへ（UC-O03。household_id NOT NULL
  // 化以降、未所属では記録・ペットを作成できないため）。
  if (!membership) {
    if (await hasActiveGuestGrant(supabase, user.id)) redirect("/guest");
    redirect("/onboarding");
  }
  const householdId = membership.householdId;
  // viewer には編集系 UI を出さない（UC-A06。サーバー強制は RLS / Server Action）。
  const readOnly = !canEdit(membership.role);

  // タグ絞り込み: 該当タグを持つ記録 id を先に解決しておく。
  let taggedIds: string[] | null = null;
  if (activeTag) {
    const { data: tagged } = await supabase
      .from("record_tags")
      .select("record_id")
      .eq("tag_id", activeTag.id);
    taggedIds = (tagged ?? []).map((t) => t.record_id);
  }

  // 一覧 + 先頭写真 + 付与タグの取得クエリ（条件・並び順込み）。
  // チャンクごとに新しいクエリを組み立てるため関数にしている。
  function buildListQuery(withCount: boolean) {
    let query = supabase
      .from("daycare_records")
      .select(
        "*, record_photos(*), record_tags(tags(id, name))",
        withCount ? { count: "exact" } : undefined,
      );

    if (householdId) query = query.or(householdScopeFilter(householdId));
    if (filters.source !== "all") query = query.eq("source", filters.source);
    if (filters.from) query = query.gte("record_date", filters.from);
    if (filters.to) query = query.lte("record_date", filters.to);
    if (filters.q) query = query.or(buildIlikeOr(filters.q));
    // 該当が 0 件なら確実に空にする（in([]) は全件にならないよう注意）。
    if (taggedIds) query = query.in("id", taggedIds.length > 0 ? taggedIds : [""]);

    switch (filters.sort) {
      case "date_asc":
        query = query
          .order("record_date", { ascending: true })
          .order("created_at", { ascending: true })
          .order("id", { ascending: true });
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
        // id は同時刻 insert のタイブレーク（記録詳細の前後ナビと同じ順序規則）
        query = query
          .order("record_date", { ascending: false })
          .order("created_at", { ascending: false })
          .order("id", { ascending: false });
    }
    return query;
  }

  // 「もっと見る」で先頭からの表示件数を増やす（ページ差し替えではなく追記。
  // page はもっと見るを押した回数 + 1 = 表示中のバッチ数）。タイムラインの
  // 文脈を保ったまま過去へ辿れる（proto 合意 / notes.md）。
  // Data API は 1 レスポンス最大 1000 行（supabase/config.toml の max_rows）
  // なので、それを超える表示件数は 1000 行ずつに分けて取得して繋ぐ。
  const SUPABASE_MAX_ROWS = 1000;
  const limitRows = filters.page * PAGE_SIZE;
  let list: RecordWithPhotos[] = [];
  let total = 0;
  for (let from = 0; from < limitRows; from += SUPABASE_MAX_ROWS) {
    const to = Math.min(from + SUPABASE_MAX_ROWS, limitRows) - 1;
    const { data, count } = await buildListQuery(from === 0)
      .range(from, to)
      .returns<RecordWithPhotos[]>();
    const rows = data ?? [];
    if (from === 0) total = count ?? 0;
    list = list.concat(rows);
    // このチャンクが要求より少ない = もう続きがない
    if (rows.length < to - from + 1) break;
  }
  const active = hasActiveFilters(filters) || activeTag != null;

  // タグチップのリンク（現在の検索条件は保ったまま tag だけ切り替え、ページは先頭へ戻す）。
  function tagHref(tagId: string | null): string {
    const qs = buildQueryString(filters, { page: 1 });
    const params = new URLSearchParams(qs.startsWith("?") ? qs.slice(1) : qs);
    if (tagId) params.set("tag", tagId);
    const s = params.toString();
    return s ? `/?${s}` : "/";
  }

  // 「もっと見る」のリンク（選択中タグを保持）。
  function pageHref(page: number): string {
    const qs = buildQueryString(filters, { page });
    const params = new URLSearchParams(qs.startsWith("?") ? qs.slice(1) : qs);
    if (activeTag) params.set("tag", activeTag.id);
    const s = params.toString();
    return s ? `/?${s}` : "/";
  }

  // 記録元チップ（proto 合意: ワンタップで おうち/保育園 を絞り込む。URL が正）。
  function sourceHref(source: "all" | "home" | "daycare"): string {
    const qs = buildQueryString(filters, { source, page: 1 });
    const params = new URLSearchParams(qs.startsWith("?") ? qs.slice(1) : qs);
    if (activeTag) params.set("tag", activeTag.id);
    const s = params.toString();
    return s ? `/?${s}` : "/";
  }
  const sourceChips = [
    { value: "all", label: "すべて" },
    { value: "home", label: "おうち" },
    { value: "daycare", label: "保育園" },
  ] as const;

  // 各記録の先頭写真サムネに署名付き URL を付与
  const thumbPaths = list
    .map((r) => r.record_photos?.[0]?.storage_path)
    .filter((p): p is string => Boolean(p));

  const urlByPath = await createPhotoSignedUrls(thumbPaths);

  // 日付ソート時は日付見出しのタイムラインにする（UC-H01）。体重ソート時は
  // 日付順にならないため、従来どおりカード内に日付を出すフラット表示のまま。
  const groupByDate =
    filters.sort === "date_desc" || filters.sort === "date_asc";
  const dateGroups: { date: string; items: typeof list }[] = [];
  if (groupByDate) {
    for (const r of list) {
      const last = dateGroups[dateGroups.length - 1];
      if (last && last.date === r.record_date) last.items.push(r);
      else dateGroups.push({ date: r.record_date, items: [r] });
    }
  }
  const todayISO = jstDateISO();
  const yesterdayISO = jstDateISO(-1);
  const relativeLabel = (d: string) =>
    d === todayISO ? "今日" : d === yesterdayISO ? "昨日" : null;

  const recordCard = (r: (typeof list)[number], showDate: boolean) => {
    const thumbPath = r.record_photos?.[0]?.storage_path;
    const thumbUrl = thumbPath ? urlByPath.get(thumbPath) : undefined;
    const photoCount = r.record_photos?.length ?? 0;

    return (
      <li key={r.id}>
        <Link
          href={`/records/${r.id}`}
          className="flex gap-3 rounded-2xl bg-surface p-3 shadow-sm ring-1 ring-border transition hover:ring-border"
        >
          <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-xl bg-surface-muted">
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
              <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                <PawPrint className="h-8 w-8" aria-hidden="true" />
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <SourceBadge source={r.source} />
              {r.weight_kg != null && (
                <span className="inline-flex items-center gap-1 rounded-full bg-surface-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                  <Scale className="h-3.5 w-3.5" aria-hidden="true" />
                  {r.weight_kg}kg
                </span>
              )}
            </div>
            {showDate && (
              <p className="mt-1 text-sm font-semibold text-foreground">
                {formatDate(r.record_date)}
              </p>
            )}
            <p className="mt-0.5 text-sm text-muted-foreground">
              {excerpt(r.body) || "（本文なし）"}
            </p>
            {(() => {
              const recordTags = tagsFromJoin(r.record_tags);
              return recordTags.length > 0 ? (
                <div className="mt-1 flex flex-wrap gap-1">
                  {recordTags.map((tg) => (
                    <span
                      key={tg.id}
                      className="rounded-full bg-surface-muted px-2 py-0.5 text-xs text-muted-foreground"
                    >
                      #{tg.name}
                    </span>
                  ))}
                </div>
              ) : null;
            })()}
            {photoCount > 0 && (
              <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                <Camera className="h-3.5 w-3.5" aria-hidden="true" />
                写真 {photoCount} 枚
              </p>
            )}
          </div>
        </Link>
      </li>
    );
  };

  return (
    <>
      {/* inert 範囲・タブバー分の下端余白は (app)/layout.tsx と globals.css が受け持つ */}
      <main id="main" className="mx-auto max-w-2xl px-4 py-6">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-xl font-bold text-foreground">記録一覧</h1>
        </div>

        {/* key で絞り込み変更時に再マウントし、入力欄を現在の URL 条件に同期する */}
        <RecordFilters
          key={buildQueryString(filters)}
          filters={filters}
          activeTagId={activeTag?.id ?? null}
        />

        {/* 記録元チップ（常設・ワンタップ） */}
        <div className="mb-3 flex items-center gap-1.5" aria-label="記録元で絞り込み">
          {sourceChips.map((c) => {
            const isActive = filters.source === c.value;
            return (
              <Link
                key={c.value}
                href={sourceHref(c.value)}
                aria-current={isActive ? "page" : undefined}
                className={
                  "rounded-full px-3.5 py-1.5 text-sm font-medium transition " +
                  (isActive
                    ? "bg-primary text-primary-foreground"
                    : "bg-surface text-foreground ring-1 ring-border hover:bg-surface-muted")
                }
              >
                {c.label}
              </Link>
            );
          })}
        </div>

        {total > 0 && (
          <p className="mb-3 text-sm text-muted-foreground">
            全 {total} 件
            {list.length < total && <span>（{list.length} 件を表示中）</span>}
          </p>
        )}

        {dictionaryTags.length > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-1.5">
            {activeTag ? (
              <Link
                href={tagHref(null)}
                className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-0.5 text-xs font-medium text-muted-foreground transition hover:bg-surface-muted"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
                タグ解除
              </Link>
            ) : (
              <span className="text-xs font-medium text-muted-foreground">
                タグで絞り込み:
              </span>
            )}
            {dictionaryTags.map((t) => {
              const isActive = activeTag?.id === t.id;
              return (
                <Link
                  key={t.id}
                  href={isActive ? tagHref(null) : tagHref(t.id)}
                  aria-current={isActive ? "page" : undefined}
                  className={
                    "rounded-full px-2.5 py-0.5 text-xs font-medium transition " +
                    (isActive
                      ? "bg-primary text-primary-foreground"
                      : "bg-surface-muted text-muted-foreground hover:bg-muted")
                  }
                >
                  #{t.name}
                </Link>
              );
            })}
          </div>
        )}

        {list.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border p-10 text-center text-muted-foreground">
            {active ? (
              <>条件に該当する記録はありません。</>
            ) : readOnly ? (
              // viewer には中央の「＋」が無いので、追加の案内はしない（UC-A06）
              <>
                まだ記録がありません。
                <br />
                ご家族が記録を追加すると、ここに表示されます。
              </>
            ) : (
              <>
                まだ記録がありません。
                <br />
                下の「＋」から最初の記録を追加しましょう。
              </>
            )}
          </div>
        ) : groupByDate ? (
          <div className="space-y-5">
            {dateGroups.map((g) => {
              const rel = relativeLabel(g.date);
              return (
                <section key={g.date} aria-label={formatDate(g.date)}>
                  <h2 className="mb-2 flex items-baseline gap-2 text-sm font-semibold text-foreground">
                    {rel ?? formatDate(g.date)}
                    {rel && (
                      <span className="text-xs font-normal text-muted-foreground">
                        {formatDate(g.date)}
                      </span>
                    )}
                  </h2>
                  <ul className="space-y-3">
                    {g.items.map((r) => recordCard(r, false))}
                  </ul>
                </section>
              );
            })}
          </div>
        ) : (
          <ul className="space-y-3">{list.map((r) => recordCard(r, true))}</ul>
        )}

        {/* もっと見る: 表示済みは保ったまま次のバッチを足す（scroll 位置も保持） */}
        {list.length < total && (
          <div className="mt-6 flex justify-center">
            <Link
              href={pageHref(filters.page + 1)}
              scroll={false}
              className="rounded-full border border-border px-6 py-2.5 text-sm font-medium text-foreground transition hover:bg-surface-muted"
            >
              もっと見る（残り {total - list.length} 件）
            </Link>
          </div>
        )}
      </main>
    </>
  );
}
