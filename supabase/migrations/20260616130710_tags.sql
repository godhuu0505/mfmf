-- =============================================================
-- mfmf / ペット保育園記録アプリ  フェーズ2 タグ機能
--   - 記録に自由なタグ（例: 体調, 食欲, トリミング）を付け、絞り込み・集計に使う
-- 共有方針 (A) を踏襲: household_id は持たず owner_id (= auth.uid()) ベースで RLS
-- 既存テーブル / RLS / Storage ポリシーは変更しない（テーブル追加のみ）。
-- =============================================================

-- ---------------------------------------------------------------
-- 1. テーブル: tags (オーナーごとのタグ辞書)
-- ---------------------------------------------------------------
create table if not exists public.tags (
  id          uuid        primary key default gen_random_uuid(),
  owner_id    uuid        not null references auth.users (id) on delete cascade,
  name        text        not null,
  created_at  timestamptz not null default now(),
  -- 空白のみのタグ名は禁止 / 長すぎる名前も禁止
  constraint tags_name_not_blank check (char_length(btrim(name)) between 1 and 50),
  -- 同一オーナー内でタグ名は一意（大文字小文字・前後空白はアプリ側で正規化）
  constraint tags_owner_name_unique unique (owner_id, name)
);

comment on table public.tags is '記録に付与する自由タグ（オーナーごとの辞書）';
comment on column public.tags.name is 'タグ名（オーナー内で一意。前後空白はアプリ側で除去）';

create index if not exists tags_owner_name_idx
  on public.tags (owner_id, name);

-- ---------------------------------------------------------------
-- 2. テーブル: record_tags (記録 ↔ タグ の多対多)
-- ---------------------------------------------------------------
create table if not exists public.record_tags (
  record_id   uuid        not null references public.daycare_records (id) on delete cascade,
  tag_id      uuid        not null references public.tags (id)            on delete cascade,
  -- RLS を単純・堅牢にするため owner_id を冗長に保持（= 記録/タグのオーナー）
  owner_id    uuid        not null references auth.users (id)             on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (record_id, tag_id)
);

comment on table public.record_tags is '記録に付与されたタグ（多対多の中間テーブル）';

create index if not exists record_tags_tag_idx
  on public.record_tags (tag_id);
create index if not exists record_tags_owner_idx
  on public.record_tags (owner_id);

-- ---------------------------------------------------------------
-- 3. RLS (行レベルセキュリティ) — owner_id = auth.uid() ベース
-- ---------------------------------------------------------------
alter table public.tags        enable row level security;
alter table public.record_tags enable row level security;

-- tags: 自分のタグのみ参照・操作可能
drop policy if exists "tags_select_own" on public.tags;
create policy "tags_select_own"
  on public.tags for select
  using (auth.uid() = owner_id);

drop policy if exists "tags_insert_own" on public.tags;
create policy "tags_insert_own"
  on public.tags for insert
  with check (auth.uid() = owner_id);

drop policy if exists "tags_update_own" on public.tags;
create policy "tags_update_own"
  on public.tags for update
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

drop policy if exists "tags_delete_own" on public.tags;
create policy "tags_delete_own"
  on public.tags for delete
  using (auth.uid() = owner_id);

-- record_tags: 自分の付与分のみ参照・操作可能。
-- insert 時は紐づく記録・タグも自分の所有であることを必須にする（横取り防止）。
drop policy if exists "record_tags_select_own" on public.record_tags;
create policy "record_tags_select_own"
  on public.record_tags for select
  using (auth.uid() = owner_id);

drop policy if exists "record_tags_insert_own" on public.record_tags;
create policy "record_tags_insert_own"
  on public.record_tags for insert
  with check (
    auth.uid() = owner_id
    and exists (
      select 1 from public.daycare_records r
      where r.id = record_tags.record_id
        and r.owner_id = auth.uid()
    )
    and exists (
      select 1 from public.tags t
      where t.id = record_tags.tag_id
        and t.owner_id = auth.uid()
    )
  );

drop policy if exists "record_tags_delete_own" on public.record_tags;
create policy "record_tags_delete_own"
  on public.record_tags for delete
  using (auth.uid() = owner_id);
