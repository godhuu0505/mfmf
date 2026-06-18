import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PHOTO_BUCKET } from "@/types/database";
import AppHeader from "@/components/AppHeader";
import PhotoGallery, { type GalleryImage } from "@/components/PhotoGallery";

export const dynamic = "force-dynamic";

export const metadata = { title: "ギャラリー" };

const MAX_PHOTOS = 300;
const SIGNED_URL_TTL = 60 * 60; // 1時間

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

  // record_photos の RLS は親記録の owner で制限される（owner スコープ）。
  const { data } = await supabase
    .from("record_photos")
    .select("id, storage_path, record_id, daycare_records!inner(record_date)")
    .order("created_at", { ascending: false })
    .limit(MAX_PHOTOS)
    .returns<PhotoRow[]>();

  const rows = data ?? [];

  // 親記録の日付で降順に整列。
  rows.sort((a, b) => {
    const da = a.daycare_records?.record_date ?? "";
    const db = b.daycare_records?.record_date ?? "";
    return db.localeCompare(da);
  });

  let images: GalleryImage[] = [];
  if (rows.length > 0) {
    const { data: signed } = await supabase.storage
      .from(PHOTO_BUCKET)
      .createSignedUrls(
        rows.map((r) => r.storage_path),
        SIGNED_URL_TTL,
      );
    images = rows
      .map((r, i): GalleryImage | null => {
        const url = signed?.[i]?.signedUrl;
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
  }

  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-2xl px-4 py-6">
        <div className="mb-4">
          <Link href="/" className="text-sm text-slate-500 hover:text-slate-800">
            ← 一覧へ戻る
          </Link>
        </div>
        <h1 className="mb-1 text-xl font-bold text-slate-900">ギャラリー</h1>
        <p className="mb-6 text-sm text-slate-500">
          すべての写真を新しい順に表示します。写真をタップすると拡大できます。
        </p>

        {images.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300 p-10 text-center text-slate-500">
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
