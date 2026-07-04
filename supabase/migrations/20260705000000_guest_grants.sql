-- =============================================================
-- mfmf / Phase 3.5 S4 (Issue #93) — 外部ゲスト基盤: guest_grants + ゲスト RLS
--
-- 保育園・ペット/ベビーシッターを「対象ペット・期間限定」のゲストとして招く
-- （UC-G01〜G07）。内部 role（household_members.role = owner/editor/viewer）とは
-- 別系統の付与テーブルで表現する。可視範囲は D8 の最厳格ルール:
--   ゲストに見えるのは「担当ペットのプロフィール」＋「付与期間内の日付で、
--   世帯が明示共有した記録（daycare_records.guest_visible = true）」＋
--   「ゲスト自身が書いた記録」だけ。既定は deny。
--   写真（record_photos）・タグ・メンバー構成・他ペットは一切見えない
--   （写真共有 UC-S04 は 🟡 のまま本 migration の対象外）。
--
-- 書き込みは「期間内に担当ペットの記録を追加」のみ（UC-G03。更新・削除は不可）。
-- 期間外・失効（revoked_at）で読み書きとも自動無効化（UC-G04）。
-- ゲストの記入は世帯に残る（UC-G07: household_id = 世帯 / owner_id = ゲスト。
-- 世帯メンバーは records_select_member でそのまま閲覧できる）。
--
-- UC-H11（2026-07-04 ヒアリング決定）: ペット削除時、記録は残す（既存の
-- ON DELETE SET NULL を維持）が guest_grants は CASCADE で消す。
--
-- ロールバック手順（本 migration を取り消す場合）:
--   drop policy if exists "records_select_guest" on public.daycare_records;
--   drop policy if exists "records_insert_guest" on public.daycare_records;
--   drop policy if exists "pets_select_guest" on public.pets;
--   drop function if exists public.has_guest_record_access(uuid, uuid, date);
--   drop function if exists public.has_guest_access(uuid, uuid);
--   drop table if exists public.guest_grants;
--   alter table public.daycare_records drop column if exists guest_visible;
-- =============================================================

-- ---------------------------------------------------------------
-- 1. テーブル: guest_grants（対象ペット・期間限定のゲスト付与）
-- ---------------------------------------------------------------
create table if not exists public.guest_grants (
  id           uuid        primary key default gen_random_uuid(),
  household_id uuid        not null references public.households (id) on delete cascade,
  user_id      uuid        not null references auth.users (id)        on delete cascade,
  scope_pet_id uuid        not null references public.pets (id)       on delete cascade,
  role         text        not null check (role in ('guest:daycare', 'guest:sitter')),
  valid_from   date        not null default current_date,
  valid_to     date,       -- null = 取り消し（revoked_at）まで有効
  revoked_at   timestamptz,
  created_by   uuid        not null references auth.users (id) on delete cascade,
  created_at   timestamptz not null default now(),
  check (valid_to is null or valid_to >= valid_from)
);

comment on table public.guest_grants is
  '外部ゲスト（保育園/シッター）への対象ペット・期間限定アクセス付与（UC-G01）。内部 role とは別系統';
comment on column public.guest_grants.scope_pet_id is
  '担当ペット。ペット削除で付与も消える（CASCADE = UC-H11 の決定）';
comment on column public.guest_grants.valid_to is
  '有効期限（この日まで有効・null は取り消しまで）。期間判定は日付単位';

create index if not exists guest_grants_user_idx on public.guest_grants (user_id);
create index if not exists guest_grants_household_idx on public.guest_grants (household_id);
create index if not exists guest_grants_pet_idx on public.guest_grants (scope_pet_id);

alter table public.guest_grants enable row level security;

grant select, insert, update, delete on public.guest_grants to authenticated;
grant all on public.guest_grants to service_role;

-- ---------------------------------------------------------------
-- 2. RLS ヘルパー（SECURITY DEFINER・search_path 固定）
--    guest_grants 自身しか参照しないため、pets / daycare_records のポリシーから
--    呼んでも相互再帰しない。
-- ---------------------------------------------------------------

-- 「今日」時点で有効な付与があるか（ペットプロフィール等の可視判定 UC-G02）。
create or replace function public.has_guest_access(p_household uuid, p_pet uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.guest_grants g
    where g.user_id = auth.uid()
      and g.household_id = p_household
      and g.scope_pet_id = p_pet
      and g.revoked_at is null
      and current_date >= g.valid_from
      and (g.valid_to is null or current_date <= g.valid_to)
  );
$$;

comment on function public.has_guest_access(uuid, uuid) is
  '呼び出しユーザーが当該世帯の当該ペットに「今日」有効なゲスト付与を持つか（UC-G02/G04）';

revoke all on function public.has_guest_access(uuid, uuid) from public;
grant execute on function public.has_guest_access(uuid, uuid) to authenticated, service_role;

-- 記録日ベースの判定: 付与が「今日」有効で、かつ記録日が付与期間内（D8:
-- 預かり期間外の記録は共有済みでも見えない・書けない）。
create or replace function public.has_guest_record_access(
  p_household uuid, p_pet uuid, p_record_date date
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.guest_grants g
    where g.user_id = auth.uid()
      and g.household_id = p_household
      and g.scope_pet_id = p_pet
      and g.revoked_at is null
      and current_date >= g.valid_from
      and (g.valid_to is null or current_date <= g.valid_to)
      and p_record_date >= g.valid_from
      and (g.valid_to is null or p_record_date <= g.valid_to)
  );
$$;

comment on function public.has_guest_record_access(uuid, uuid, date) is
  'ゲストの記録アクセス判定: 付与が今日有効 かつ 記録日が付与期間内（UC-G02/G03/G04・D8）';

revoke all on function public.has_guest_record_access(uuid, uuid, date) from public;
grant execute on function public.has_guest_record_access(uuid, uuid, date)
  to authenticated, service_role;

-- ---------------------------------------------------------------
-- 3. guest_grants の RLS ポリシー
--    管理（発行・失効・削除）は世帯 owner のみ（UC-G01）。ゲスト本人は自分宛て
--    付与の閲覧のみ（自分の期間・対象を確認できる）。自己付与・自己昇格は不可
--    （UC-G06。insert は owner ロール必須 = 非メンバーには常に false）。
-- ---------------------------------------------------------------
create policy "guest_grants_select_own_or_owner"
  on public.guest_grants for select
  using (
    user_id = auth.uid()
    or public.has_household_role(household_id, array['owner'])
  );

create policy "guest_grants_insert_owner"
  on public.guest_grants for insert
  with check (
    public.has_household_role(household_id, array['owner'])
    and created_by = auth.uid()
    -- 対象ペットは必ず自世帯のペット（他世帯のペットへの付与 = 越境を防ぐ）
    and exists (
      select 1 from public.pets p
      where p.id = guest_grants.scope_pet_id
        and p.household_id = guest_grants.household_id
    )
  );

create policy "guest_grants_update_owner"
  on public.guest_grants for update
  using (public.has_household_role(household_id, array['owner']))
  with check (
    public.has_household_role(household_id, array['owner'])
    and exists (
      select 1 from public.pets p
      where p.id = guest_grants.scope_pet_id
        and p.household_id = guest_grants.household_id
    )
  );

create policy "guest_grants_delete_owner"
  on public.guest_grants for delete
  using (public.has_household_role(household_id, array['owner']));

-- ---------------------------------------------------------------
-- 4. 記録の明示共有フラグ（D8: 既定 deny・owner/editor が記録単位で共有）
--    既存アプリは列を指定しないため default false のまま = 挙動不変。
-- ---------------------------------------------------------------
alter table public.daycare_records
  add column if not exists guest_visible boolean not null default false;

comment on column public.daycare_records.guest_visible is
  '対象ペットのゲストに見せるか（D8: 既定 false = ゲストには見えない。ゲスト自身の記入は常に本人可視）';

-- ---------------------------------------------------------------
-- 5. ゲストの読み書きポリシー（既存 member ポリシーと OR で併存）
-- ---------------------------------------------------------------

-- 担当ペットのプロフィールのみ閲覧可（UC-G02。他ペット・他世帯は不可視）
create policy "pets_select_guest"
  on public.pets for select
  using (public.has_guest_access(household_id, id));

-- 記録の閲覧: 担当ペット かつ 記録日が期間内 かつ（自分の記入 or 明示共有）
create policy "records_select_guest"
  on public.daycare_records for select
  using (
    pet_id is not null
    and (owner_id = auth.uid() or guest_visible)
    and public.has_guest_record_access(household_id, pet_id, record_date)
  );

-- 記録の追加: 自分名義・担当ペット・期間内のみ（UC-G03。guest_visible は
-- 世帯側の共有フラグのため、ゲストは立てられない = 既定 false のまま）。
-- 更新・削除ポリシーは付けない（追加のみ）。
create policy "records_insert_guest"
  on public.daycare_records for insert
  with check (
    pet_id is not null
    and owner_id = auth.uid()
    and guest_visible = false
    and public.has_guest_record_access(household_id, pet_id, record_date)
  );
