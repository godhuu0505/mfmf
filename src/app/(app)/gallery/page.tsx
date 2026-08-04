import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentHouseholdId, householdScopeFilter } from "@/lib/household";
import { createPhotoSignedUrls } from "@/lib/photos";
import PhotoGallery, { type GalleryImage } from "@/components/PhotoGallery";

export const dynamic = "force-dynamic";

export const metadata = { title: "アルバム" };

const MAX_PHOTOS = 300;

type PhotoRow = {
  id: string;
  storage_path: string;
  record_id: string;
  daycare_records: { record_date: string } | null;
};

function formatDate(d: string) {
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(d));
}

export default async function GalleryPage() {
  const supabase = await createClient();
  // 読み取りは household 基準へ寄せる（未所属は owner_id RLS にフォールバック）。
  // record_photos の household_id は親 daycare_records から継承済み。
  const householdId = await getCurrentHouseholdId(supabase);

  let query = supabase
    .from("record_photos")
    .select("id, storage_path, record_id, daycare_records!inner(record_date)")
    .order("created_at", { ascending: false })
    .limit(MAX_PHOTOS);
  if (householdId) query = query.or(householdScopeFilter(householdId));
  const { data } = await query.returns<PhotoRow[]>();

  const rows = data ?? [];

  // 親記録の日付で降順に整列。
  rows.sort((a, b) => {
    const da = a.daycare_records?.record_date ?? "";
    const db = b.daycare_records?.record_date ?? "";
    return db.localeCompare(da);
  });

  const urlByPath = await createPhotoSignedUrls(
    rows.map((r) => r.storage_path),
  );

  // 月ごとにグループ化して見出しを付ける（proto 合意 / notes.md「アルバム」）。
  // rows は記録日の降順なので、そのまま前から詰めれば月も新しい順に並ぶ。
  const monthGroups: { ym: string; label: string; images: GalleryImage[] }[] =
    [];
  for (const r of rows) {
    const url = urlByPath.get(r.storage_path);
    if (!url || !r.daycare_records) continue;
    const image: GalleryImage = {
      id: r.id,
      url,
      recordId: r.record_id,
      caption: formatDate(r.daycare_records.record_date),
    };
    const [y, m] = r.daycare_records.record_date.split("-");
    const ym = `${y}-${m}`;
    const last = monthGroups[monthGroups.length - 1];
    if (last && last.ym === ym) last.images.push(image);
    else
      monthGroups.push({ ym, label: `${y}年${Number(m)}月`, images: [image] });
  }
  const isEmpty = monthGroups.length === 0;

  return (
    <>
      <main id="main" className="mx-auto max-w-2xl px-4 py-6">
        <div className="mb-4">
          <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
            ← 一覧へ戻る
          </Link>
        </div>
        <h1 className="mb-1 text-xl font-bold text-foreground">アルバム</h1>
        <p className="mb-6 text-sm text-muted-foreground">
          すべての写真を月ごとに新しい順で表示します。写真をタップすると拡大できます。
        </p>

        {isEmpty ? (
          <div className="rounded-2xl border border-dashed border-border p-10 text-center text-muted-foreground">
            まだ写真がありません。
            <br />
            記録に写真を追加すると、ここにまとまって表示されます。
          </div>
        ) : (
          <div className="space-y-6">
            {monthGroups.map((g) => (
              <section key={g.ym} aria-label={g.label}>
                <h2 className="mb-2 text-sm font-semibold text-foreground">
                  {g.label}
                </h2>
                <PhotoGallery
                  images={g.images}
                  gridClassName="grid grid-cols-3 gap-1.5 sm:grid-cols-4"
                />
              </section>
            ))}
          </div>
        )}
      </main>
    </>
  );
}
