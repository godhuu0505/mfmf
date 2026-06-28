-- =============================================================
-- mfmf / ペット保育園記録アプリ  フェーズ2 ユーザープロフィール
--   - 表示名 (display_name) や記入者の既定値 (default_author) を保存し、
--     UX を向上させるための最小限のプロフィール土台。
-- 共有方針 (A) を踏襲: household_id は持たず owner_id (= auth.uid()) ベースで RLS。
-- 既存テーブル / ポリシーは変更しない（追加のみ）。
-- =============================================================

-- ---------------------------------------------------------------
-- 1. テーブル: profiles (1 ユーザーにつき 1 行)
-- ---------------------------------------------------------------
create table if not exists public.profiles (
  owner_id       uuid        not null default auth.uid()
                             references auth.users (id) on delete cascade,
  display_name   text,                              -- 画面に表示する名前（任意）
  default_author text,                              -- 記録フォームの「記入者」の既定値（任意）
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (owner_id)
);

comment on table public.profiles is 'ユーザーごとのプロフィール / アカウント設定 (owner_id = auth.uid())';
comment on column public.profiles.display_name is '画面に表示する名前（任意）';
comment on column public.profiles.default_author is '記録フォームの「記入者」の既定値（任意）';

-- ---------------------------------------------------------------
-- 2. updated_at 自動更新トリガ（既存の public.set_updated_at() を再利用）
-- ---------------------------------------------------------------
drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row
  execute function public.set_updated_at();

-- ---------------------------------------------------------------
-- 3. RLS (行レベルセキュリティ): 自分のプロフィールのみ参照・操作可能
-- ---------------------------------------------------------------
alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles for select
  using (auth.uid() = owner_id);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
  on public.profiles for insert
  with check (auth.uid() = owner_id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles for update
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

drop policy if exists "profiles_delete_own" on public.profiles;
create policy "profiles_delete_own"
  on public.profiles for delete
  using (auth.uid() = owner_id);
