import { createClient } from "@/lib/supabase/server";
import type { Tag } from "@/types/database";

// ログイン中オーナーのタグ辞書を名前順で取得する（サジェスト・絞り込み用）。
// RLS により自分のタグのみが返る。
export async function getOwnerTags(): Promise<Pick<Tag, "id" | "name">[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("tags")
    .select("id, name")
    .order("name", { ascending: true })
    .returns<Pick<Tag, "id" | "name">[]>();
  return data ?? [];
}
