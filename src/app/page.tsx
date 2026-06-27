import Link from "next/link";
import Image from "next/image";
import { createClient } from "@/lib/supabase/server";
import {
  PHOTO_BUCKET,
  SOURCE_LABEL,
  tagsFromJoin,
  type RecordSource,
  type RecordWithPhotos,
} from "@/types/database";
import { getOwnerTags } from "@/lib/tags";
import AppHeader from "@/components/AppHeader";

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

// フィルタタブの定義（値 / ラベル）
const FILTERS: { value: "all" | RecordSource; label: string }[] = [
  { value: "all", label: "すべて" },
  { value: "daycare", label: "保育園" },
  { value: "home", label: "おうち" },
];

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string; tag?: string }>;
}) {
  const { source: sourceParam, tag: tagParam } = await searchParams;
  const filter: "all" | RecordSource =
    sourceParam === "daycare" || sourceParam === "home" ? sourceParam : "all";

  const supabase = await createClient();

  // 絞り込み UI 用にオーナーのタグ辞書を取得し、選択中タグを特定する。
  const ownerTags = await getOwnerTags();
  const activeTag = tagParam
    ? ownerTags.find((t) => t.id === tagParam) ?? null
    : null;

  // 一覧 + 先頭写真 + 付与タグをまとめて取得。
  let query = supabase
    .from("daycare_records")
    .select("*, record_photos(*), record_tags(tags(id, name))")
    .order("record_date", { ascending: false })
    .order("created_at", { ascending: false });

  if (filter !== "all") query = query.eq("source", filter);

  // タグ絞り込み: 該当タグを持つ記録 id に限定する（埋め込みタグはそのまま全件表示）。
  if (activeTag) {
    const { data: tagged } = await supabase
      .from("record_tags")
      .select("record_id")
      .eq("tag_id", activeTag.id);
    const ids = (tagged ?? []).map((t) => t.record_id);
    // 該当が 0 件なら確実に空にする（in([]) は全件にならないよう注意）。
    query = query.in("id", ids.length > 0 ? ids : [""]);
  }

  const { data: records } = await query.returns<RecordWithPhotos[]>();

  const list = records ?? [];

  // 選択中の絞り込みを保ったまま遷移する href を組み立てる。
  function buildHref(next: { source?: "all" | RecordSource; tag?: string | null }) {
    const params = new URLSearchParams();
    const s = next.source ?? filter;
    const t = next.tag === undefined ? activeTag?.id : next.tag;
    if (s && s !== "all") params.set("source", s);
    if (t) params.set("tag", t);
    const qs = params.toString();
    return qs ? `/?${qs}` : "/";
  }

  // 各記録の先頭写真サムネに署名付き URL を付与
  const thumbPaths = list
    .map((r) => r.record_photos?.[0]?.storage_path)
    .filter((p): p is string => Boolean(p));

  const signed =
    thumbPaths.length > 0
      ? (
          await supabase.storage
            .from(PHOTO_BUCKET)
            .createSignedUrls(thumbPaths, 60 * 60)
        ).data
      : [];

  const urlByPath = new Map<string, string>();
  signed?.forEach((s) => {
    if (s.path && s.signedUrl) urlByPath.set(s.path, s.signedUrl);
  });

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

        <nav className="mb-4 inline-flex rounded-lg border border-slate-200 bg-white p-0.5">
          {FILTERS.map((f) => {
            const active = filter === f.value;
            const href = buildHref({ source: f.value });
            return (
              <Link
                key={f.value}
                href={href}
                aria-current={active ? "page" : undefined}
                className={
                  "rounded-md px-4 py-1.5 text-sm font-medium transition " +
                  (active
                    ? "bg-slate-900 text-white"
                    : "text-slate-600 hover:bg-slate-100")
                }
              >
                {f.label}
              </Link>
            );
          })}
        </nav>

        {ownerTags.length > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-1.5">
            {activeTag ? (
              <Link
                href={buildHref({ tag: null })}
                className="rounded-full border border-slate-300 px-3 py-0.5 text-xs font-medium text-slate-600 transition hover:bg-slate-100"
              >
                ✕ タグ解除
              </Link>
            ) : (
              <span className="text-xs font-medium text-slate-400">タグで絞り込み:</span>
            )}
            {ownerTags.map((t) => {
              const active = activeTag?.id === t.id;
              return (
                <Link
                  key={t.id}
                  href={active ? buildHref({ tag: null }) : buildHref({ tag: t.id })}
                  aria-current={active ? "page" : undefined}
                  className={
                    "rounded-full px-2.5 py-0.5 text-xs font-medium transition " +
                    (active
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
            {filter === "all" && !activeTag ? (
              <>
                まだ記録がありません。
                <br />
                「＋ 新規」から最初の記録を追加しましょう。
              </>
            ) : (
              <>この絞り込みに該当する記録はありません。</>
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
      </main>
    </>
  );
}
