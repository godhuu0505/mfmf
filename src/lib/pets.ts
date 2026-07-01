import { createClient } from "@/lib/supabase/server";
import { getHouseholdIdForUser, householdScopeFilter } from "@/lib/household";
import type { Pet } from "@/types/database";

// 現在ログイン中ユーザーのペット一覧を取得する（作成日昇順）。
// 読み取りは household 基準へ寄せる（Phase 3.5 S1 手順7）。所属世帯を解決できれば
// household_id で絞り込み、未所属なら従来どおり owner_id RLS にフォールバックする。
export async function listPets(): Promise<Pet[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const householdId = await getHouseholdIdForUser(supabase, user.id);

  let query = supabase
    .from("pets")
    .select("*")
    .order("created_at", { ascending: true });
  if (householdId) query = query.or(householdScopeFilter(householdId));
  const { data } = await query.returns<Pet[]>();

  return data ?? [];
}
