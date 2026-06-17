import { createClient } from "@/lib/supabase/server";
import type { Profile } from "@/types/database";

// 現在ログイン中ユーザーの profile を取得する。
// 未ログイン、または profile 行が無い場合は null を返す。
// RLS (owner_id = auth.uid()) により自分の行のみ取得できる。
export async function getCurrentProfile(): Promise<Profile | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await supabase
    .from("profiles")
    .select("owner_id, display_name, default_author, created_at, updated_at")
    .eq("owner_id", user.id)
    .maybeSingle();

  return (data as Profile | null) ?? null;
}
