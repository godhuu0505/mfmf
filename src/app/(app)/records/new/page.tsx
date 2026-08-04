import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { canEdit, getCurrentMembership } from "@/lib/household";
import { getCurrentProfile } from "@/lib/profile";
import { listPets } from "@/lib/pets";
import RecordForm from "@/components/RecordForm";
import { createRecord } from "@/app/(app)/records/actions";
import { getTagDictionary } from "@/lib/tags";
import { jstTodayISO } from "@/lib/dateRange";

export const dynamic = "force-dynamic";

export default async function NewRecordPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const { date } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // JST の今日（UTC 日付だと日本の 0:00〜8:59 に前日になってしまう）
  const today = jstTodayISO();
  // カレンダーの「この日の記録を追加」から日付を引き継ぐ（UC-C01）。不正値は今日。
  const defaultDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : today;
  // クイック記録からの下書きは sessionStorage 経由（RecordForm がマウント時に
  // 取り込む。src/lib/quickDraft.ts）。URL には載せない。
  // householdId は Storage パス {household_id}/{record_id}/... の先頭セグメント（手順8）。
  const [profile, pets, dictionaryTags, membership] = await Promise.all([
    getCurrentProfile(),
    listPets(),
    getTagDictionary(),
    getCurrentMembership(supabase),
  ]);
  // 世帯を持たないユーザーはまずオンボーディングへ（UC-O03。未所属では作成不可）。
  if (!membership) redirect("/onboarding");
  // viewer は記録を追加できない（UC-A01/A06。サーバー強制は RLS / Server Action）。
  if (!canEdit(membership.role)) redirect("/");
  const householdId = membership.householdId;
  const tagSuggestions = dictionaryTags.map((t) => t.name);

  return (
    <>
      {/* 全画面モーダル型（ヘッダーは HideOnFormRoute が隠す）。離脱は
          フォーム上部の確認つきキャンセルに一本化するため、戻るリンクは置かない */}
      <main id="main" className="mx-auto max-w-2xl px-4 py-6">
        <h1 className="mb-6 text-xl font-bold text-foreground">記録を追加</h1>

        <RecordForm
          action={createRecord}
          ownerId={user.id}
          householdId={householdId}
          defaultDate={defaultDate}
          defaultAuthor={profile?.default_author ?? ""}
          pets={pets.map((p) => ({ id: p.id, name: p.name }))}
          defaultPetId={pets[0]?.id ?? null}
          tagSuggestions={tagSuggestions}
          submitLabel="保存する"
          cancelHref="/"
        />
      </main>
    </>
  );
}
