import Link from "next/link";
import Image from "next/image";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { withSignedUrls } from "@/lib/photos";
import type { DaycareRecord, RecordPhoto } from "@/types/database";
import AppHeader from "@/components/AppHeader";
import RecordForm from "@/components/RecordForm";
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

  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-2xl px-4 py-6">
        <div className="mb-4">
          <Link href="/" className="text-sm text-slate-500 hover:text-slate-800">
            ← 一覧へ戻る
          </Link>
        </div>

        {isEdit ? (
          <>
            <h1 className="mb-6 text-xl font-bold text-slate-900">記録を編集</h1>
            <RecordForm
              action={updateRecord.bind(null, record.id)}
              defaultDate={record.record_date}
              defaultBody={record.body}
              submitLabel="更新する"
              cancelHref={`/records/${record.id}`}
            />

            {photos.length > 0 && (
              <section className="mt-8">
                <h2 className="mb-3 text-sm font-medium text-slate-700">
                  登録済みの写真
                </h2>
                <div className="grid grid-cols-3 gap-2">
                  {photos.map((p) => (
                    <div
                      key={p.id}
                      className="group relative aspect-square overflow-hidden rounded-xl bg-slate-100"
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
            <div className="mb-4 flex items-center justify-between">
              <h1 className="text-xl font-bold text-slate-900">
                {formatDate(record.record_date)}
              </h1>
              <Link
                href={`/records/${record.id}?edit=1`}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
              >
                編集
              </Link>
            </div>

            <article className="whitespace-pre-wrap rounded-2xl bg-white p-5 text-slate-800 shadow-sm ring-1 ring-slate-200">
              {record.body || (
                <span className="text-slate-400">（本文なし）</span>
              )}
            </article>

            {photos.length > 0 && (
              <section className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-3">
                {photos.map((p) => (
                  <div
                    key={p.id}
                    className="relative aspect-square overflow-hidden rounded-xl bg-slate-100"
                  >
                    {p.url && (
                      <Image
                        src={p.url}
                        alt=""
                        fill
                        sizes="(max-width:640px) 50vw, 200px"
                        className="object-cover"
                        unoptimized
                      />
                    )}
                  </div>
                ))}
              </section>
            )}

            <form
              action={deleteRecord.bind(null, record.id)}
              className="mt-10 border-t border-slate-200 pt-6"
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
