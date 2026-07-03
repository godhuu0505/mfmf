import { createClient } from "@/lib/supabase/server";
import type { Tag } from "@/types/database";

// ログイン中ユーザーが参照できるタグ辞書を名前順で取得する（サジェスト・絞り込み用）。
// Phase 3.5 UC-M02: RLS（owner_id ポリシー + household メンバー併存ポリシー）により
// 自分のタグに加えて同一世帯メンバーの共有タグも返る。
export async function getTagDictionary(): Promise<Pick<Tag, "id" | "name">[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("tags")
    .select("id, name")
    .order("name", { ascending: true })
    .returns<Pick<Tag, "id" | "name">[]>();
  return data ?? [];
}
