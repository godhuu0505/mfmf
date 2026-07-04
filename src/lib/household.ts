import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";

// Server 用 Supabase クライアントの型（Server Component / Server Action / Route Handler 共通）。
type ServerClient = Awaited<ReturnType<typeof createClient>>;

// 「現在の世帯」を保持する Cookie（UC-H08）。値は household_id。
// 実際のメンバーシップと突き合わせてから使うため、偽装されても越境は起きない
// （一次防衛線は RLS）。
export const HOUSEHOLD_COOKIE = "mfmf-household";

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

export type HouseholdRole = "owner" | "editor" | "viewer";

export type Membership = {
  householdId: string;
  role: HouseholdRole;
};

// role が記録・写真・ペット等を書き込めるか（S2 RBAC: viewer は閲覧のみ）。
export function canEdit(role: HouseholdRole): boolean {
  return role === "owner" || role === "editor";
}

async function getMembershipForUser(
  supabase: ServerClient,
  userId: string,
): Promise<Membership | null> {
  const { data } = await supabase
    .from("household_members")
    .select("household_id, role, created_at")
    .eq("user_id", userId);
  if (!data || data.length === 0) return null;

  // UC-H08: Cookie の「現在の世帯」が自分のメンバーシップに実在すればそれを優先する。
  // 無効値（退出済み・偽装・他人の世帯）は単に無視して既定の優先度選択へ倒す。
  const cookieStore = await cookies();
  const selected = cookieStore.get(HOUSEHOLD_COOKIE)?.value;
  if (selected) {
    const match = data.find((m) => m.household_id === selected);
    if (match) {
      return {
        householdId: match.household_id,
        role: (match.role in ROLE_PRIORITY ? match.role : "viewer") as HouseholdRole,
      };
    }
  }

  const [best] = data.slice().sort(
    (a, b) =>
      (ROLE_PRIORITY[a.role] ?? 9) - (ROLE_PRIORITY[b.role] ?? 9) ||
      a.created_at.localeCompare(b.created_at) ||
      a.household_id.localeCompare(b.household_id),
  );
  return {
    householdId: best.household_id,
    role: (best.role in ROLE_PRIORITY ? best.role : "viewer") as HouseholdRole,
  };
}

export async function getHouseholdIdForUser(
  supabase: ServerClient,
  userId: string,
): Promise<string | null> {
  return (await getMembershipForUser(supabase, userId))?.householdId ?? null;
}

// 現在ログイン中ユーザーの「現在の世帯」とロールを返す（未ログイン/未所属は null）。
// UI のロール別出し分け（UC-A06）と Server Action のロール検査に使う。
export async function getCurrentMembership(
  supabase: ServerClient,
): Promise<Membership | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  return getMembershipForUser(supabase, user.id);
}

// Server Action 冒頭のロール検査: viewer からの書き込みを分かりやすいエラーで拒否し、
// 通れば書き込みに使う household_id（未所属は null = RLS が最終防衛線）を返す。
// 一次防衛線はあくまで RLS（クライアント回避不可）。ここは UX のための早期検査。
export async function requireEditableHousehold(
  supabase: ServerClient,
  userId: string,
): Promise<string | null> {
  const membership = await getMembershipForUser(supabase, userId);
  if (membership && !canEdit(membership.role)) {
    throw new Error("閲覧のみの権限（viewer）のため、追加・編集・削除はできません");
  }
  return membership?.householdId ?? null;
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

// 指定世帯における自分のロールを返す（非メンバーは null）。
// 「記録が属する世帯」での権限を検査する用途（Cookie の現在世帯とは独立）。
export async function getRoleInHousehold(
  supabase: ServerClient,
  userId: string,
  householdId: string,
): Promise<HouseholdRole | null> {
  const { data } = await supabase
    .from("household_members")
    .select("role")
    .eq("user_id", userId)
    .eq("household_id", householdId)
    .maybeSingle();
  if (!data) return null;
  return (data.role in ROLE_PRIORITY ? data.role : "viewer") as HouseholdRole;
}

// 切替 UI 用: 現在ログイン中ユーザーの全メンバーシップ（世帯名つき・加入順）。
export type MembershipWithName = Membership & { householdName: string };

export async function listCurrentMemberships(
  supabase: ServerClient,
): Promise<MembershipWithName[]> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data } = await supabase
    .from("household_members")
    .select("household_id, role, households(name)")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true })
    .returns<
      { household_id: string; role: string; households: { name: string } | null }[]
    >();

  return (data ?? []).map((m) => ({
    householdId: m.household_id,
    role: (m.role in ROLE_PRIORITY ? m.role : "viewer") as HouseholdRole,
    householdName: m.households?.name ?? "",
  }));
}
