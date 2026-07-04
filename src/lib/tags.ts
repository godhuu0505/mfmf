import { createClient } from "@/lib/supabase/server";
import { getCurrentMembership, householdScopeFilter } from "@/lib/household";
import type { Tag } from "@/types/database";

// タグ辞書を名前順で取得する（サジェスト・絞り込み用）。
// Phase 3.5 UC-M02/UC-H08: 辞書は世帯単位。householdId 未指定なら「現在の世帯」に
// 絞る（複数世帯所属時に他世帯のタグ名が混ざらないように）。記録編集ではその記録が
// 属する世帯を渡す。未所属時は RLS の可視範囲（自分の未所属タグのみ）にフォールバック。
export async function getTagDictionary(
  householdId?: string | null,
): Promise<Pick<Tag, "id" | "name">[]> {
  const supabase = await createClient();
  const scope =
    householdId ?? (await getCurrentMembership(supabase))?.householdId ?? null;

  let query = supabase.from("tags").select("id, name");
  if (scope) query = query.or(householdScopeFilter(scope));
  const { data } = await query
    .order("name", { ascending: true })
    .returns<Pick<Tag, "id" | "name">[]>();
  return data ?? [];
}
