-- =============================================================
-- mfmf / ペット保育園記録アプリ  フェーズ1 初期スキーマ
-- 共有方針: (A) 1アカウント共用
--   - household_id は持たず、owner_id (= auth.uid()) ベースで RLS を設定
--   - 将来 (B) household 共有へ移行する場合は household_id 列を追加して移行
-- =============================================================

-- ---------------------------------------------------------------
-- 1. テーブル: daycare_records (保育園からの記録)
-- ---------------------------------------------------------------
create table if not exists public.daycare_records (
  id          uuid        primary key default gen_random_uuid(),
  owner_id    uuid        not null references auth.users (id) on delete cascade,
  record_date date        not null default current_date,  -- その記録の対象日
  body        text        not null default '',            -- 保育園からのテキスト
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.daycare_records is '保育園からの日次記録';
comment on column public.daycare_records.record_date is '記録の対象日';
comment on column public.daycare_records.body is '保育園からのテキスト本文';

create index if not exists daycare_records_owner_date_idx
  on public.daycare_records (owner_id, record_date desc);

-- ---------------------------------------------------------------
-- 2. テーブル: record_photos (記録に紐づく写真 / 1記録に複数枚)
-- ---------------------------------------------------------------
create table if not exists public.record_photos (
  id           uuid        primary key default gen_random_uuid(),
  record_id    uuid        not null references public.daycare_records (id) on delete cascade,
  storage_path text        not null,                      -- Storage 上のパス
  created_at   timestamptz not null default now()
);

comment on table public.record_photos is '記録に紐づく写真メタデータ';
comment on column public.record_photos.storage_path is 'daycare-photos バケット内のオブジェクトパス';

create index if not exists record_photos_record_idx
  on public.record_photos (record_id);

-- ---------------------------------------------------------------
-- 3. updated_at 自動更新トリガ
-- ---------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists daycare_records_set_updated_at on public.daycare_records;
create trigger daycare_records_set_updated_at
  before update on public.daycare_records
  for each row
  execute function public.set_updated_at();

-- ---------------------------------------------------------------
-- 4. RLS (行レベルセキュリティ)
-- ---------------------------------------------------------------
alter table public.daycare_records enable row level security;
alter table public.record_photos  enable row level security;

-- daycare_records: 自分のレコードのみ参照・操作可能
drop policy if exists "records_select_own" on public.daycare_records;
create policy "records_select_own"
  on public.daycare_records for select
  using (auth.uid() = owner_id);

drop policy if exists "records_insert_own" on public.daycare_records;
create policy "records_insert_own"
  on public.daycare_records for insert
  with check (auth.uid() = owner_id);

drop policy if exists "records_update_own" on public.daycare_records;
create policy "records_update_own"
  on public.daycare_records for update
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

drop policy if exists "records_delete_own" on public.daycare_records;
create policy "records_delete_own"
  on public.daycare_records for delete
  using (auth.uid() = owner_id);

-- record_photos: 親 record の owner のみ参照・操作可能
drop policy if exists "photos_select_own" on public.record_photos;
create policy "photos_select_own"
  on public.record_photos for select
  using (
    exists (
      select 1 from public.daycare_records r
      where r.id = record_photos.record_id
        and r.owner_id = auth.uid()
    )
  );

drop policy if exists "photos_insert_own" on public.record_photos;
create policy "photos_insert_own"
  on public.record_photos for insert
  with check (
    exists (
      select 1 from public.daycare_records r
      where r.id = record_photos.record_id
        and r.owner_id = auth.uid()
    )
  );

drop policy if exists "photos_delete_own" on public.record_photos;
create policy "photos_delete_own"
  on public.record_photos for delete
  using (
    exists (
      select 1 from public.daycare_records r
      where r.id = record_photos.record_id
        and r.owner_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------
-- 5. Storage バケット: daycare-photos (private)
-- ---------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('daycare-photos', 'daycare-photos', false)
on conflict (id) do nothing;

-- Storage RLS: 自分のフォルダ (owner_id をパス先頭に持つ) のみ操作可能
--   オブジェクトパス規約: {owner_id}/{record_id}/{filename}
drop policy if exists "daycare_photos_select_own" on storage.objects;
create policy "daycare_photos_select_own"
  on storage.objects for select
  using (
    bucket_id = 'daycare-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "daycare_photos_insert_own" on storage.objects;
create policy "daycare_photos_insert_own"
  on storage.objects for insert
  with check (
    bucket_id = 'daycare-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "daycare_photos_delete_own" on storage.objects;
create policy "daycare_photos_delete_own"
  on storage.objects for delete
  using (
    bucket_id = 'daycare-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
