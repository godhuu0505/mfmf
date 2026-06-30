-- =============================================================
-- mfmf / Phase 3.5 S1 (Issue #92 手順4 / #44) — household メンバー判定ヘルパー
--
-- household メンバーシップ RLS を owner_id ポリシーと「併存」で導入するための
-- 共通ヘルパー関数を追加する。本 migration は関数のみ（ポリシー追加は後続
-- 20260630140100_household_rls_policies.sql）。アプリ挙動は変えない。
--
-- 設計（既存 public.get_shared_view / public.set_updated_at の方針に揃える）:
--   - SECURITY DEFINER + `set search_path = ''` で固定し、参照は全て完全修飾名。
--     → RLS ポリシーから household_members を参照する際、関数所有者（postgres）
--       権限で実行されるため household_members の RLS を迂回でき、members 自己参照
--       による RLS 再帰ループを構造的に回避する（一次防衛線の RLS は維持）。
--   - stable / language sql の最小実装。返すのは boolean のみで、呼び出し元へ
--     他ユーザーのメンバーシップ情報は一切漏らさない（最小権限）。
--   - 認可判定は常に auth.uid()（呼び出しユーザー）基準。引数で渡されるのは
--     「対象 household」と「許可ロール集合」だけ。
--
-- allowed_roles の扱い:
--   - NULL もしくは空配列 → ロールを問わず「当該 household のメンバーであるか」。
--     本スライス（テナント分離の証明）ではメンバーであれば足りるため、ポリシーは
--     NULL を渡して「メンバーか否か」で判定する。
--   - 非空配列 → そのロールのいずれかを持つメンバーであるか（将来の RBAC #45 で
--     'owner' / 'member' 等を絞り込む用途に使えるよう、シグネチャを今から用意する）。
--
-- is_household_member(target_household, target_user):
--   「*任意の* ユーザー target_user が target_household のメンバーか」を返す姉妹関数。
--   has_household_role が呼び出しユーザー(auth.uid())専用なのに対し、こちらは行の
--   owner_id を渡して「その行の所有者は本当にその household のメンバーか」を検証する用途。
--   household_id と owner_id はどちらも移行期はクライアント書込み可能なため、メンバー
--   判定ポリシーが household_id 単独を信用すると、owner_id を別 household のユーザーへ
--   付け替える / 自分の行の household_id を他 household の UUID にする経路で越境が起こる。
--   本関数で「owner_id ∈ household_id」を併せて要求し、両者の整合を強制する。
--   同じく SECURITY DEFINER + search_path 固定で household_members の RLS を迂回する。
--
-- ロールバック手順（本 migration を取り消す場合）:
--   後続のポリシー migration を先に戻してから:
--   drop function if exists public.is_household_member(uuid, uuid);
--   drop function if exists public.has_household_role(uuid, text[]);
-- =============================================================

create or replace function public.has_household_role(
  target_household uuid,
  allowed_roles    text[] default null
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.household_members m
    where m.household_id = target_household
      and m.user_id = auth.uid()
      and (
        allowed_roles is null
        or cardinality(allowed_roles) = 0
        or m.role = any (allowed_roles)
      )
  );
$$;

comment on function public.has_household_role(uuid, text[]) is
  '呼び出しユーザー(auth.uid())が target_household のメンバーか（allowed_roles 指定時はそのロールのいずれかを持つか）を返す。SECURITY DEFINER + search_path 固定で household_members の RLS を迂回し再帰を防ぐ。RLS ポリシーから利用する。';

-- 権限: get_shared_view と同方針で PUBLIC の既定 EXECUTE を剥がし、Data API の
-- authenticated / service_role にのみ明示付与する（anon はテーブルに触れないため不要）。
revoke all on function public.has_household_role(uuid, text[]) from public;
grant execute on function public.has_household_role(uuid, text[]) to authenticated, service_role;

-- target_user が target_household のメンバーかを返す（呼び出しユーザー非依存）。
-- 行の owner_id と household_id の整合（owner が当該 household に属するか）を RLS で
-- 強制するために用いる。SECURITY DEFINER + search_path 固定で再帰を防ぐ。
create or replace function public.is_household_member(
  target_household uuid,
  target_user      uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.household_members m
    where m.household_id = target_household
      and m.user_id = target_user
  );
$$;

comment on function public.is_household_member(uuid, uuid) is
  '任意のユーザー target_user が target_household のメンバーかを返す。行の owner_id ∈ household_id 整合を RLS ポリシーで強制する用途。SECURITY DEFINER + search_path 固定で household_members の RLS を迂回し再帰を防ぐ。';

revoke all on function public.is_household_member(uuid, uuid) from public;
grant execute on function public.is_household_member(uuid, uuid) to authenticated, service_role;
