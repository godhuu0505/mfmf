import Link from "next/link";
import Image from "next/image";
import { createClient } from "@/lib/supabase/server";
import { PHOTO_BUCKET, type RecordWithPhotos } from "@/types/database";
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

export default async function HomePage() {
  const supabase = await createClient();

  const { data: records } = await supabase
    .from("daycare_records")
    .select("*, record_photos(*)")
    .order("record_date", { ascending: false })
    .order("created_at", { ascending: false })
    .returns<RecordWithPhotos[]>();

  const list = records ?? [];

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
          <Link
            href="/records/new"
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-700"
          >
            ＋ 新規
          </Link>
        </div>

        {list.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300 p-10 text-center text-slate-500">
            まだ記録がありません。
            <br />
            「＋ 新規」から最初の記録を追加しましょう。
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
                      <p className="text-sm font-semibold text-slate-900">
                        {formatDate(r.record_date)}
                      </p>
                      <p className="mt-1 text-sm text-slate-600">
                        {excerpt(r.body) || "（本文なし）"}
                      </p>
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
