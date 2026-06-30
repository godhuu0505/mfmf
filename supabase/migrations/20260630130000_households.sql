-- =============================================================
-- mfmf / Phase 3.5 S1 (Issue #92 / #43) — household テナント基盤の追加
--
-- 共有方針を (A) owner_id = auth.uid() 単独から (B) household メンバーシップへ
-- 「無停止で」段階移行する。本 migration は手順 1：households /
-- household_members テーブルの追加（RLS 付き）のみを行う。
--   - 既存 owner_id ベースの RLS は一切変更しない（移行期間中は弱めない）。
--   - 既存 20260616130704_init.sql は編集しない（連番で新規追加）。
--   - RLS ヘルパー関数（SECURITY DEFINER）は後続 PR (#44) で導入する。本 PR は
--     再帰しない素朴なポリシーに留める。
--   - GRANT は 20260616130713_grants.sql / Issue #88 の方針に揃える
--     （authenticated に CRUD、service_role に全権、anon には付与しない）。
--
-- ロールバック手順（本 migration を取り消す場合）:
--   drop table if exists public.household_members;
--   drop table if exists public.households;
--   （子→親の順。RLS ポリシー・GRANT はテーブル削除に追随して消える。）
-- =============================================================

-- ---------------------------------------------------------------
-- 1. テーブル: households （世帯 = テナントの単位）
-- ---------------------------------------------------------------
create table if not exists public.households (
  id          uuid        primary key default gen_random_uuid(),
  name        text        not null default '',
  created_at  timestamptz not null default now()
);

comment on table public.households is 'テナント（世帯）の単位。メンバーは household_members で管理する';
comment on column public.households.name is '世帯名（任意・既定は空文字。アプリから後で命名可能）';

-- ---------------------------------------------------------------
-- 2. テーブル: household_members （世帯 ↔ ユーザーのメンバーシップ）
-- ---------------------------------------------------------------
create table if not exists public.household_members (
  household_id uuid        not null references public.households (id) on delete cascade,
  user_id      uuid        not null references auth.users (id)        on delete cascade,
  role         text        not null default 'owner',
  created_at   timestamptz not null default now(),
  primary key (household_id, user_id)
);

comment on table public.household_members is '世帯メンバーシップ（household ↔ auth.users の多対多）';
comment on column public.household_members.role is 'メンバー種別（既定 owner。将来 member 等を追加予定）';

-- RLS / 参照の "自分が属する世帯" 引きを高速化（PK は (household_id, user_id)
-- 先頭なので user_id 単独の索引を別途用意する）。
create index if not exists household_members_user_idx
  on public.household_members (user_id);

-- ---------------------------------------------------------------
-- 3. RLS（行レベルセキュリティ）
--    本 PR では「自分がメンバーである household / その members 行のみ select 可」
--    の素朴なポリシーのみ付与する（user_id = auth.uid() 基準）。
--    書き込み（世帯作成・招待）は後続 PR でメンバーシップ UI と共に解禁するため、
--    insert/update/delete ポリシーは敢えて付けない（= RLS 既定の deny のまま）。
--    バックフィル migration は postgres ロールで実行され RLS を迂回するので、
--    select-only でも初期データ投入には支障しない。
-- ---------------------------------------------------------------
alter table public.households        enable row level security;
alter table public.household_members enable row level security;

-- household_members: 自分のメンバーシップ行のみ参照可（他テーブルを参照しない＝
-- 再帰しない素朴なポリシー）。
drop policy if exists "household_members_select_self" on public.household_members;
create policy "household_members_select_self"
  on public.household_members for select
  using (user_id = auth.uid());

-- households: 自分がメンバーである世帯のみ参照可。
-- 参照先 household_members のポリシーは上記の通り再帰しないため、相互再帰は起きない。
drop policy if exists "households_select_member" on public.households;
create policy "households_select_member"
  on public.households for select
  using (
    exists (
      select 1 from public.household_members m
      where m.household_id = households.id
        and m.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------
-- 4. GRANT（Data API ロール）
--    20260616130713_grants.sql / Issue #88 の方針に揃える。
--    grants.sql の ALTER DEFAULT PRIVILEGES でも authenticated CRUD は自動付与
--    されるが、意図を明示するため本 migration でも明示的に付与する。
--    anon には一切付与しない（20260630120000_revoke_anon_grants.sql の方針）。
-- ---------------------------------------------------------------
grant select, insert, update, delete on public.households        to authenticated;
grant select, insert, update, delete on public.household_members to authenticated;
grant all on public.households        to service_role;
grant all on public.household_members to service_role;
