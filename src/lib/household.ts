import { createClient } from "@/lib/supabase/server";

// Server 用 Supabase クライアントの型（Server Component / Server Action / Route Handler 共通）。
type ServerClient = Awaited<ReturnType<typeof createClient>>;

// 指定ユーザーが所属する世帯 ID を解決する。
//
// Phase 3.5 S1（Issue #92 手順7 / #44）: 書き込みで household_id をセットし、読み取りを
// household 基準へ寄せるための共通ヘルパー。household_members を user_id で引く
// （RLS `household_members_select_self` により自分のメンバーシップ行のみ返る）。
//
// 未所属（バックフィル対象外の新規ユーザー等）は null を返す。移行期は household_id が
// nullable であり、owner_id ベースの RLS がそのまま一次防衛線として機能するため、
// null の場合は household スコープを適用せず従来どおり owner_id RLS にフォールバックする。
//
// 複数メンバーシップがある場合の選択は 20260630130100 のバックフィルと同じタイブレーク
// （owner ロール優先 → 作成が古い順 → household_id 昇順）で決定的にする。
export async function getHouseholdIdForUser(
  supabase: ServerClient,
  userId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("household_members")
    .select("household_id")
    .eq("user_id", userId)
    .order("role", { ascending: false }) // 'owner' を 'member' より優先
    .order("created_at", { ascending: true })
    .order("household_id", { ascending: true })
    .limit(1)
    .maybeSingle();

  return data?.household_id ?? null;
}

// 現在ログイン中ユーザーが所属する世帯 ID を解決する（読み取り経路の便宜ラッパー）。
// 未ログインまたは未所属は null（呼び出し側は household スコープを適用しない）。
export async function getCurrentHouseholdId(
  supabase: ServerClient,
): Promise<string | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  return getHouseholdIdForUser(supabase, user.id);
}
