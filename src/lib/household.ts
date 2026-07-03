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
// 複数メンバーシップがある場合は、書き込み権限の強いロールの世帯を優先する
// （owner → editor → viewer。S2 #46 で role が 3 値になったため、文字列の辞書順では
// 'viewer' が最上位になってしまう。辞書順ソートは使わず明示的な優先度で選ぶ）。
// 同ロール内のタイブレークは 20260630130100 のバックフィルと同じ
// （作成が古い順 → household_id 昇順）で決定的にする。
const ROLE_PRIORITY: Record<string, number> = { owner: 0, editor: 1, viewer: 2 };

export async function getHouseholdIdForUser(
  supabase: ServerClient,
  userId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("household_members")
    .select("household_id, role, created_at")
    .eq("user_id", userId);
  if (!data || data.length === 0) return null;

  const [best] = data.slice().sort(
    (a, b) =>
      (ROLE_PRIORITY[a.role] ?? 9) - (ROLE_PRIORITY[b.role] ?? 9) ||
      a.created_at.localeCompare(b.created_at) ||
      a.household_id.localeCompare(b.household_id),
  );
  return best.household_id;
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

// 読み取りを household 基準へ寄せるときの PostgREST `or` フィルタ式。
// 「当該 household の行」＋「household_id が null の行」を対象にする。
//
// null を含める理由（無停止移行の要）: バックフィル migration の本番適用後・本コードの
// 配信前の期間に、旧コード（household_id 未設定）が作成した行は household_id=null のまま
// 残る。所有者は既に household_members 行を持つため、`household_id = hh` の等値だけで絞ると
// これらの自分の行が一覧から突然消える。null 行を併せて拾うことでこの取りこぼしを防ぐ。
//
// 越境しない理由: household_id=null の行は has_household_role(null)=false のため、RLS 上は
// owner_id ポリシー（owner_id = auth.uid()）経由でしか返らない。つまり返る null 行は常に
// 呼び出しユーザー自身の行に限られ、他 household の null 行は混入しない。
export function householdScopeFilter(householdId: string): string {
  return `household_id.eq.${householdId},household_id.is.null`;
}
