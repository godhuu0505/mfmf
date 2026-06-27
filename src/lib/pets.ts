import { createClient } from "@/lib/supabase/server";
import type { Pet } from "@/types/database";

// 現在ログイン中ユーザーのペット一覧を取得する（作成日昇順）。
// RLS (owner_id = auth.uid()) により自分のペットのみ取得できる。
export async function listPets(): Promise<Pet[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data } = await supabase
    .from("pets")
    .select("*")
    .order("created_at", { ascending: true })
    .returns<Pet[]>();

  return data ?? [];
}
