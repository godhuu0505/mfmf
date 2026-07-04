"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { toSource } from "@/types/database";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ゲストが担当ペットの記録を追加する（UC-G03）。
// 追加できるのは「自分名義・担当ペット・期間内」のみで、これは RLS
// （records_insert_guest）が一次防衛線として強制する。ここでは所属世帯の解決と
// 分かりやすいエラーだけを担う。写真・タグはゲストの対象外（D8）のため扱わない。
export async function createGuestRecord(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const petId = String(formData.get("pet_id") || "").trim();
  if (!UUID_RE.test(petId)) {
    throw new Error("対象のペットが不正です");
  }

  // 対象ペットの世帯を解決する（ゲストには pets_select_guest で担当ペットのみ見える）。
  const { data: pet } = await supabase
    .from("pets")
    .select("household_id")
    .eq("id", petId)
    .maybeSingle();
  if (!pet) {
    throw new Error("対象のペットが見つかりません（権限がないか、期間外です）");
  }

  const record_date = String(formData.get("record_date") || "");
  const body = String(formData.get("body") || "");
  const source = toSource(formData.get("source"));
  const author = String(formData.get("author") || "").trim();
  const rawWeight = String(formData.get("weight_kg") || "").trim();
  const parsedWeight = rawWeight === "" ? null : Number(rawWeight);
  const weight_kg =
    parsedWeight !== null && Number.isFinite(parsedWeight) && parsedWeight > 0
      ? parsedWeight
      : null;

  // guest_visible は立てない（false）。ゲストの記入は本人に見え、世帯には残る。
  const { error } = await supabase.from("daycare_records").insert({
    owner_id: user.id,
    household_id: pet.household_id,
    pet_id: petId,
    record_date,
    body,
    source,
    author,
    weight_kg,
    guest_visible: false,
  });
  if (error) {
    throw new Error(
      `記録の追加に失敗しました（期間外・権限切れの可能性があります）: ${error.message}`,
    );
  }

  revalidatePath("/guest");
  redirect("/guest");
}
