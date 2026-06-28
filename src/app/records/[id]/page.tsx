import Link from "next/link";
import Image from "next/image";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { withSignedUrls } from "@/lib/photos";
import { listPets } from "@/lib/pets";
import { getOwnerTags } from "@/lib/tags";
import {
  SOURCE_LABEL,
  tagsFromJoin,
  type DaycareRecord,
  type RecordPhoto,
  type RecordTagJoin,
} from "@/types/database";
import AppHeader from "@/components/AppHeader";
import RecordForm from "@/components/RecordForm";
import PhotoGallery from "@/components/PhotoGallery";
import { updateRecord, deletePhoto, deleteRecord } from "@/app/records/actions";

export const dynamic = "force-dynamic";

function formatDate(d: string) {
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(new Date(d));
}

export default async function RecordDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ edit?: string }>;
}) {
  const { id } = await params;
  const { edit } = await searchParams;
  const isEdit = edit === "1";

  const supabase = await createClient();

  const { data: record } = await supabase
    .from("daycare_records")
    .select("*")
    .eq("id", id)
    .single<DaycareRecord>();

  if (!record) notFound();

  const { data: photoRows } = await supabase
    .from("record_photos")
    .select("*")
    .eq("record_id", id)
    .order("created_at", { ascending: true })
    .returns<RecordPhoto[]>();

  const photos = await withSignedUrls(photoRows ?? []);
  const pets = isEdit ? await listPets() : [];

  // この記録に付与されたタグ
  const { data: tagRows } = await supabase
    .from("record_tags")
    .select("tags(id, name)")
    .eq("record_id", id)
    .returns<RecordTagJoin[]>();
  const tags = tagsFromJoin(tagRows);
  const tagNames = tags.map((t) => t.name);

  // 編集フォームのサジェスト用にオーナーのタグ辞書を取得
  const tagSuggestions = isEdit
    ? (await getOwnerTags()).map((t) => t.name)
    : [];

  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-2xl px-4 py-6">
        <div className="mb-4">
          <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
            ← 一覧へ戻る
          </Link>
        </div>

        {isEdit ? (
          <>
            <h1 className="mb-6 text-xl font-bold text-foreground">記録を編集</h1>
            <RecordForm
              action={updateRecord.bind(null, record.id)}
              ownerId={record.owner_id}
              recordId={record.id}
              defaultDate={record.record_date}
              defaultBody={record.body}
              defaultSource={record.source}
              defaultAuthor={record.author}
              defaultWeightKg={record.weight_kg}
              pets={pets.map((p) => ({ id: p.id, name: p.name }))}
              defaultPetId={record.pet_id}
              defaultTags={tagNames}
              tagSuggestions={tagSuggestions}
              submitLabel="更新する"
              cancelHref={`/records/${record.id}`}
            />

            {photos.length > 0 && (
              <section className="mt-8">
                <h2 className="mb-3 text-sm font-medium text-foreground">
                  登録済みの写真
                </h2>
                <div className="grid grid-cols-3 gap-2">
                  {photos.map((p) => (
                    <div
                      key={p.id}
                      className="group relative aspect-square overflow-hidden rounded-xl bg-surface-muted"
                    >
                      {p.url && (
                        <Image
                          src={p.url}
                          alt=""
                          fill
                          sizes="(max-width:640px) 33vw, 200px"
                          className="object-cover"
                          unoptimized
                        />
                      )}
                      <form
                        action={deletePhoto.bind(null, p.id, record.id)}
                        className="absolute right-1 top-1"
                      >
                        <button
                          type="submit"
                          className="rounded-full bg-black/60 px-2 py-1 text-xs text-white transition hover:bg-black/80"
                          aria-label="この写真を削除"
                        >
                          削除
                        </button>
                      </form>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </>
        ) : (
          <>
            <div className="mb-4 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <span
                    className={
                      "rounded-full px-2.5 py-0.5 text-xs font-medium " +
                      (record.source === "home"
                        ? "bg-amber-100 text-amber-700"
                        : "bg-sky-100 text-sky-700")
                    }
                  >
                    {record.source === "home" ? "🏠 " : "🏫 "}
                    {SOURCE_LABEL[record.source]}
                  </span>
                  {record.weight_kg != null && (
                    <span className="rounded-full bg-surface-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
                      ⚖️ {record.weight_kg}kg
                    </span>
                  )}
                </div>
                <h1 className="text-xl font-bold text-foreground">
                  {formatDate(record.record_date)}
                </h1>
                {record.author && (
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    記入者: {record.author}
                  </p>
                )}
              </div>
              <Link
                href={`/records/${record.id}?edit=1`}
                className="shrink-0 rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground transition hover:bg-surface-muted"
              >
                編集
              </Link>
            </div>

            <article className="whitespace-pre-wrap rounded-2xl bg-surface p-5 text-foreground shadow-sm ring-1 ring-border">
              {record.body || (
                <span className="text-muted-foreground">（本文なし）</span>
              )}
            </article>

            {tags.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {tags.map((t) => (
                  <Link
                    key={t.id}
                    href={`/?tag=${t.id}`}
                    className="rounded-full bg-surface-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground transition hover:bg-muted"
                  >
                    #{t.name}
                  </Link>
                ))}
              </div>
            )}

            {photos.length > 0 && (
              <section className="mt-6">
                <PhotoGallery
                  images={photos
                    .filter((p) => p.url)
                    .map((p) => ({ id: p.id, url: p.url as string }))}
                />
              </section>
            )}

            <form
              action={deleteRecord.bind(null, record.id)}
              className="mt-10 border-t border-border pt-6"
            >
              <button
                type="submit"
                className="text-sm text-red-500 transition hover:text-red-700"
              >
                この記録を削除する
              </button>
            </form>
          </>
        )}
      </main>
    </>
  );
}
