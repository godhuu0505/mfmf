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
-- ロールバック手順（本 migration を取り消す場合）:
--   後続のポリシー migration を先に戻してから:
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
