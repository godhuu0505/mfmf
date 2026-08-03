import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { canEdit, getCurrentMembership, householdScopeFilter } from "@/lib/household";
import { withSignedUrls } from "@/lib/photos";
import { listPets } from "@/lib/pets";
import { getTagDictionary } from "@/lib/tags";
import {
  SOURCE_LABEL,
  tagsFromJoin,
  type DaycareRecord,
  type RecordPhoto,
  type RecordTagJoin,
} from "@/types/database";
import RecordForm from "@/components/RecordForm";
import RecordActionsSheet from "@/components/RecordActionsSheet";
import PhotoGallery from "@/components/PhotoGallery";
import SubmitButton from "@/components/SubmitButton";
import SourceIcon from "@/components/SourceIcon";
import PhotoEditTile from "./PhotoEditTile";
import {
  updateRecord,
  deleteRecord,
  setRecordGuestVisible,
} from "@/app/(app)/records/actions";
import { Scale } from "lucide-react";

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

  // 読み取りは household 基準へ寄せる（未所属は owner_id RLS にフォールバック）。
  // いずれの経路でも RLS が一次防衛線。写真・タグは親記録経由でスコープされる。
  const membership = await getCurrentMembership(supabase);
  const householdId = membership?.householdId ?? null;
  // viewer には編集系 UI を出さない（UC-A06）。編集モードの URL 直叩きも閲覧へ倒す。
  const readOnly = membership !== null && !canEdit(membership.role);
  const isEditable = isEdit && !readOnly;

  let recordQuery = supabase.from("daycare_records").select("*").eq("id", id);
  if (householdId) recordQuery = recordQuery.or(householdScopeFilter(householdId));
  const { data: record } = await recordQuery.single<DaycareRecord>();

  if (!record) notFound();

  const { data: photoRows } = await supabase
    .from("record_photos")
    .select("*")
    .eq("record_id", id)
    .order("created_at", { ascending: true })
    .returns<RecordPhoto[]>();

  const photos = await withSignedUrls(photoRows ?? []);
  const pets = isEditable ? await listPets() : [];

  // この記録に付与されたタグ
  const { data: tagRows } = await supabase
    .from("record_tags")
    .select("tags(id, name)")
    .eq("record_id", id)
    .returns<RecordTagJoin[]>();
  const tags = tagsFromJoin(tagRows);
  const tagNames = tags.map((t) => t.name);

  // 前後の記録（UC-D01）。一覧と同じ (record_date, created_at) 順の隣を 1 件ずつ引く。
  let prevQuery = supabase
    .from("daycare_records")
    .select("id, record_date")
    .or(
      `record_date.lt.${record.record_date},and(record_date.eq.${record.record_date},created_at.lt.${record.created_at})`,
    )
    .order("record_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1);
  let nextQuery = supabase
    .from("daycare_records")
    .select("id, record_date")
    .or(
      `record_date.gt.${record.record_date},and(record_date.eq.${record.record_date},created_at.gt.${record.created_at})`,
    )
    .order("record_date", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(1);
  if (householdId) {
    prevQuery = prevQuery.or(householdScopeFilter(householdId));
    nextQuery = nextQuery.or(householdScopeFilter(householdId));
  }
  const [{ data: prevRows }, { data: nextRows }] = await Promise.all([
    prevQuery.returns<{ id: string; record_date: string }[]>(),
    nextQuery.returns<{ id: string; record_date: string }[]>(),
  ]);
  const prevRecord = prevRows?.[0] ?? null;
  const nextRecord = nextRows?.[0] ?? null;

  // 編集フォームのサジェスト用に世帯のタグ辞書を取得
  const tagSuggestions = isEditable
    ? (await getTagDictionary(record.household_id ?? householdId)).map(
        (t) => t.name,
      )
    : [];

  return (
    <>
      <main id="main" className="mx-auto max-w-2xl px-4 py-6">
        <div className="mb-4">
          <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
            ← 一覧へ戻る
          </Link>
        </div>

        {isEditable ? (
          <>
            <h1 className="mb-6 text-xl font-bold text-foreground">記録を編集</h1>
            <RecordForm
              action={updateRecord.bind(null, record.id)}
              ownerId={record.owner_id}
              householdId={record.household_id ?? householdId}
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
                    <PhotoEditTile
                      key={p.id}
                      id={p.id}
                      recordId={record.id}
                      url={p.url}
                    />
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
                      "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium " +
                      (record.source === "home"
                        ? "bg-amber-100 text-amber-900"
                        : "bg-sky-100 text-sky-900")
                    }
                  >
                    <SourceIcon source={record.source} className="h-3.5 w-3.5" />
                    {SOURCE_LABEL[record.source]}
                  </span>
                  {record.weight_kg != null && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-surface-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
                      <Scale className="h-3.5 w-3.5" aria-hidden="true" />
                      {record.weight_kg}kg
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
              {!readOnly && (
                <div className="flex shrink-0 items-center gap-2">
                  <Link
                    href={`/records/${record.id}?edit=1`}
                    className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground transition hover:bg-surface-muted"
                  >
                    編集
                  </Link>
                  <RecordActionsSheet
                    editHref={`/records/${record.id}?edit=1`}
                    deleteForm={
                      <form action={deleteRecord.bind(null, record.id)}>
                        <SubmitButton
                          pendingLabel="削除中…"
                          className="w-full rounded-xl bg-red-600 py-2.5 text-sm font-medium text-white transition hover:bg-red-700 disabled:opacity-60"
                        >
                          削除する
                        </SubmitButton>
                      </form>
                    }
                  />
                </div>
              )}
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

            {/* ゲスト共有（S4 / D8）: ペット紐付きの記録のみ。共有すると対象ペットの
                有効なゲスト（保育園/シッター）が期間内に本文を閲覧できる（写真は共有されない）。 */}
            {!readOnly && record.pet_id && (
              <form
                action={setRecordGuestVisible.bind(
                  null,
                  record.id,
                  !record.guest_visible,
                )}
                className="mt-6 flex flex-wrap items-center gap-3 rounded-2xl bg-surface p-4 shadow-sm ring-1 ring-border"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">
                    ゲスト（保育園・シッター）への共有
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {record.guest_visible
                      ? "共有中: 対象ペットの有効なゲストが期間内にこの記録の本文を閲覧できます（写真は共有されません）。"
                      : "未共有: ゲストにはこの記録は見えません（ゲスト自身が書いた記録は本人に常に見えます）。"}
                  </p>
                </div>
                <SubmitButton
                  pendingLabel="変更中…"
                  className={
                    "rounded-lg px-4 py-2 text-sm font-medium transition disabled:opacity-60 " +
                    (record.guest_visible
                      ? "border border-border text-foreground hover:bg-surface-muted"
                      : "bg-primary text-primary-foreground hover:bg-primary-hover")
                  }
                >
                  {record.guest_visible ? "共有を解除" : "ゲストに共有"}
                </SubmitButton>
              </form>
            )}

            {/* 前後の記録ナビ（UC-D01） */}
            {(prevRecord || nextRecord) && (
              <nav
                aria-label="前後の記録"
                className="mt-8 flex items-center justify-between border-t border-border pt-4 text-sm"
              >
                {prevRecord ? (
                  <Link
                    href={`/records/${prevRecord.id}`}
                    rel="prev"
                    className="font-medium text-muted-foreground transition hover:text-foreground"
                  >
                    ← {formatDate(prevRecord.record_date)}
                  </Link>
                ) : (
                  <span className="text-muted">前の記録なし</span>
                )}
                {nextRecord ? (
                  <Link
                    href={`/records/${nextRecord.id}`}
                    rel="next"
                    className="font-medium text-muted-foreground transition hover:text-foreground"
                  >
                    {formatDate(nextRecord.record_date)} →
                  </Link>
                ) : (
                  <span className="text-muted">次の記録なし</span>
                )}
              </nav>
            )}
          </>
        )}
      </main>
    </>
  );
}
