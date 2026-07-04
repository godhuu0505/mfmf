import { type SupabaseClient } from "@supabase/supabase-js";
import { type GuestRole } from "@/types/database";

export type ActiveGuestGrant = {
  id: string;
  householdId: string;
  petId: string;
  petName: string;
  role: GuestRole;
  validFrom: string;
  validTo: string | null;
};

// ログイン中ユーザーの「今日有効な」ゲスト付与を返す（UC-G02/G04）。
// guest_grants は RLS（guest_grants_select_own_or_owner）で本人分のみ、pets は
// pets_select_guest で担当ペットのみ見える。期間・失効の最終判定は DB の
// has_guest_access（記録アクセスは has_guest_record_access）が一次防衛線。
export async function listActiveGuestGrants(
  supabase: SupabaseClient,
  userId: string,
): Promise<ActiveGuestGrant[]> {
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await supabase
    .from("guest_grants")
    .select("id, household_id, scope_pet_id, role, valid_from, valid_to, pets(name)")
    .eq("user_id", userId)
    .is("revoked_at", null)
    .lte("valid_from", today)
    .or(`valid_to.is.null,valid_to.gte.${today}`)
    .order("valid_from", { ascending: false });

  return ((data ?? []) as unknown as {
    id: string;
    household_id: string;
    scope_pet_id: string;
    role: GuestRole;
    valid_from: string;
    valid_to: string | null;
    pets: { name: string } | null;
  }[]).map((g) => ({
    id: g.id,
    householdId: g.household_id,
    petId: g.scope_pet_id,
    petName: g.pets?.name ?? "（名前未取得のペット）",
    role: g.role,
    validFrom: g.valid_from,
    validTo: g.valid_to,
  }));
}

// 有効なゲスト付与を 1 件でも持つか（ルーティングの分岐用）。
export async function hasActiveGuestGrant(
  supabase: SupabaseClient,
  userId: string,
): Promise<boolean> {
  return (await listActiveGuestGrants(supabase, userId)).length > 0;
}
