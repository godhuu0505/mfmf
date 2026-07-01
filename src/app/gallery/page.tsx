import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentHouseholdId, householdScopeFilter } from "@/lib/household";
import { createPhotoSignedUrls } from "@/lib/photos";
import AppHeader from "@/components/AppHeader";
import PhotoGallery, { type GalleryImage } from "@/components/PhotoGallery";

export const dynamic = "force-dynamic";

export const metadata = { title: "ギャラリー" };

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
  const images: GalleryImage[] = rows
    .map((r): GalleryImage | null => {
      const url = urlByPath.get(r.storage_path);
      if (!url) return null;
      return {
        id: r.id,
        url,
        recordId: r.record_id,
        caption: r.daycare_records
          ? formatDate(r.daycare_records.record_date)
          : undefined,
      };
    })
    .filter((x): x is GalleryImage => x !== null);

  return (
    <>
      <AppHeader />
      <main id="main" className="mx-auto max-w-2xl px-4 py-6">
        <div className="mb-4">
          <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
            ← 一覧へ戻る
          </Link>
        </div>
        <h1 className="mb-1 text-xl font-bold text-foreground">ギャラリー</h1>
        <p className="mb-6 text-sm text-muted-foreground">
          すべての写真を新しい順に表示します。写真をタップすると拡大できます。
        </p>

        {images.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border p-10 text-center text-muted-foreground">
            まだ写真がありません。
            <br />
            記録に写真を追加すると、ここにまとまって表示されます。
          </div>
        ) : (
          <PhotoGallery
            images={images}
            gridClassName="grid grid-cols-3 gap-1.5 sm:grid-cols-4"
          />
        )}
      </main>
    </>
  );
}
