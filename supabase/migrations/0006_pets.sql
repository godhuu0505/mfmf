-- =============================================================
-- mfmf / ペット保育園記録アプリ  フェーズ2 複数ペット対応の素地
--   - pets: 飼っているペット（多頭飼いに備える）
--   - daycare_records.pet_id: 記録をペットに紐づける（nullable で段階導入）
-- 共有方針 (A) を踏襲: owner_id (= auth.uid()) ベースの RLS。
-- 既存テーブルのポリシーは変更しない（列・テーブル追加 + バックフィルのみ）。
-- =============================================================

-- ---------------------------------------------------------------
-- 1. テーブル: pets
-- ---------------------------------------------------------------
create table if not exists public.pets (
  id          uuid        primary key default gen_random_uuid(),
  owner_id    uuid        not null default auth.uid()
                          references auth.users (id) on delete cascade,
  name        text        not null default 'うちの子',
  species     text,                                   -- 種類（犬 / 猫 など・任意）
  birthday    date,                                   -- 誕生日（任意）
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.pets is '飼っているペット (owner_id = auth.uid())';
comment on column public.pets.name is 'ペットの名前';
comment on column public.pets.species is '種類（犬 / 猫 など・任意）';
comment on column public.pets.birthday is '誕生日（任意）';

create index if not exists pets_owner_idx on public.pets (owner_id, created_at);

-- updated_at 自動更新（既存の public.set_updated_at() を再利用）
drop trigger if exists pets_set_updated_at on public.pets;
create trigger pets_set_updated_at
  before update on public.pets
  for each row
  execute function public.set_updated_at();

-- ---------------------------------------------------------------
-- 2. daycare_records へ pet_id を追加（nullable）
-- ---------------------------------------------------------------
alter table public.daycare_records
  add column if not exists pet_id uuid references public.pets (id) on delete set null;

comment on column public.daycare_records.pet_id is '記録の対象ペット。未設定は NULL（段階導入）';

create index if not exists daycare_records_owner_pet_date_idx
  on public.daycare_records (owner_id, pet_id, record_date desc);

-- ---------------------------------------------------------------
-- 3. RLS: 自分のペットのみ参照・操作可能
-- ---------------------------------------------------------------
alter table public.pets enable row level security;

drop policy if exists "pets_select_own" on public.pets;
create policy "pets_select_own"
  on public.pets for select
  using (auth.uid() = owner_id);

drop policy if exists "pets_insert_own" on public.pets;
create policy "pets_insert_own"
  on public.pets for insert
  with check (auth.uid() = owner_id);

drop policy if exists "pets_update_own" on public.pets;
create policy "pets_update_own"
  on public.pets for update
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

drop policy if exists "pets_delete_own" on public.pets;
create policy "pets_delete_own"
  on public.pets for delete
  using (auth.uid() = owner_id);

-- ---------------------------------------------------------------
-- 4. バックフィル: 記録を持つオーナーごとに既定ペットを用意し、
--    pet_id が未設定の既存記録を紐づける（冪等: NULL の行のみ対象）。
-- ---------------------------------------------------------------
do $$
declare
  r        record;
  pet      uuid;
begin
  for r in
    select distinct owner_id
    from public.daycare_records
    where pet_id is null
  loop
    -- 既存ペットがあれば最古を、無ければ既定ペットを作成して使う。
    select id into pet
    from public.pets
    where owner_id = r.owner_id
    order by created_at
    limit 1;

    if pet is null then
      insert into public.pets (owner_id, name)
      values (r.owner_id, 'うちの子')
      returning id into pet;
    end if;

    update public.daycare_records
    set pet_id = pet
    where owner_id = r.owner_id and pet_id is null;
  end loop;
end $$;

-- ---------------------------------------------------------------
-- 5. daycare_records の insert/update ポリシーを pet 所有チェックで強化
--    Server Action を経由せず直接 API を叩いても、他人のペット ID を参照する
--    記録を作成 / 更新できないようにする DB 層での強制。既存の owner_id
--    チェックは維持し、pet_id が NULL でないときのみ「その pet が自分のもの」
--    であることを追加で要求する（既存ポリシーを弱めない・強化のみ）。
-- ---------------------------------------------------------------
drop policy if exists "records_insert_own" on public.daycare_records;
create policy "records_insert_own"
  on public.daycare_records for insert
  with check (
    auth.uid() = owner_id
    and (
      pet_id is null
      or exists (
        select 1 from public.pets p
        where p.id = daycare_records.pet_id
          and p.owner_id = auth.uid()
      )
    )
  );

drop policy if exists "records_update_own" on public.daycare_records;
create policy "records_update_own"
  on public.daycare_records for update
  using (auth.uid() = owner_id)
  with check (
    auth.uid() = owner_id
    and (
      pet_id is null
      or exists (
        select 1 from public.pets p
        where p.id = daycare_records.pet_id
          and p.owner_id = auth.uid()
      )
    )
  );
