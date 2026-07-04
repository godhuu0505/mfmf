-- =============================================================
-- mfmf / Phase 3.5 S4 (Issue #93) — ゲスト招待: household_invites の拡張と受諾分岐
--
-- 外部ゲスト（保育園/シッター）の招待を S3 の招待基盤（宛先メール固定 D12/D13・
-- 期限・失効・取消 UC-O09〜O11）にそのまま載せる（UC-G01「招待導線は S3 流用」）。
--   - household_invites に role guest:daycare / guest:sitter を追加し、ゲスト招待は
--     対象ペット（scope_pet_id）と期間（valid_from / valid_to）を必須の文脈として持つ。
--   - 受諾（accept_household_invite）はゲスト招待のとき household_members ではなく
--     guest_grants を作成する（メンバー化しない = 世帯情報は見えないまま UC-G02）。
--   - ゲスト一覧の表示用に get_household_guests（owner 限定・メール解決つき）を追加。
--
-- ロールバック手順（本 migration を取り消す場合）:
--   drop function if exists public.get_household_guests(uuid);
--   accept_household_invite を 20260704030000 の定義で再作成する。
--   alter table public.household_invites
--     drop constraint if exists household_invites_guest_scope,
--     drop constraint if exists household_invites_valid_range,
--     drop column if exists scope_pet_id,
--     drop column if exists valid_from,
--     drop column if exists valid_to;
--   role の check を in ('editor','viewer') に戻す（既存ゲスト招待行の削除が前提）。
-- =============================================================

-- ---------------------------------------------------------------
-- 1. household_invites の拡張
-- ---------------------------------------------------------------
alter table public.household_invites
  add column if not exists scope_pet_id uuid references public.pets (id) on delete cascade,
  add column if not exists valid_from   date,
  add column if not exists valid_to     date;

comment on column public.household_invites.scope_pet_id is
  'ゲスト招待の対象ペット（guest:* のとき必須）。ペット削除で招待ごと消える（UC-H11 と整合）';
comment on column public.household_invites.valid_from is
  'ゲスト付与の開始日（null は受諾日から）';
comment on column public.household_invites.valid_to is
  'ゲスト付与の終了日（null は取り消しまで）';

-- 招待 role にゲスト 2 種を追加（owner の直付与は引き続き不可）
alter table public.household_invites
  drop constraint if exists household_invites_role_check;
alter table public.household_invites
  add constraint household_invites_role_check
  check (role in ('editor', 'viewer', 'guest:daycare', 'guest:sitter'));

-- ゲスト招待は対象ペット必須 / 期間の前後関係
alter table public.household_invites
  drop constraint if exists household_invites_guest_scope;
alter table public.household_invites
  add constraint household_invites_guest_scope
  check (role not like 'guest:%' or scope_pet_id is not null);

alter table public.household_invites
  drop constraint if exists household_invites_valid_range;
alter table public.household_invites
  add constraint household_invites_valid_range
  check (valid_from is null or valid_to is null or valid_to >= valid_from);

-- 発行ポリシー: 対象ペットを指定する場合は「自世帯のペット」に限定（越境防止）。
drop policy if exists "invites_insert_owner" on public.household_invites;
create policy "invites_insert_owner"
  on public.household_invites for insert
  with check (
    invited_by = auth.uid()
    and public.has_household_role(household_id, array['owner'])
    and (
      scope_pet_id is null
      or exists (
        select 1 from public.pets p
        where p.id = household_invites.scope_pet_id
          and p.household_id = household_invites.household_id
      )
    )
  );

-- ---------------------------------------------------------------
-- 2. 受諾の分岐: ゲスト招待は guest_grants を作成（メンバー化しない）
--    ベースは 20260704030000 の定義（メール一致 D12/D13・冪等リトライ・
--    ユーザー単位の advisory lock は不変更）。
-- ---------------------------------------------------------------
create or replace function public.accept_household_invite(p_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_email text;
  inv     public.household_invites%rowtype;
begin
  if v_uid is null then
    raise exception 'ログインが必要です' using errcode = '42501';
  end if;

  select lower(u.email) into v_email from auth.users u where u.id = v_uid;

  select * into inv
  from public.household_invites i
  where i.token = p_token
  for update;

  if not found then
    raise exception '招待が見つかりません' using errcode = 'P0002';
  end if;
  if inv.revoked_at is not null then
    raise exception 'この招待は取り消されています' using errcode = 'P0002';
  end if;
  -- D12/D13: 宛先メール一致の強制（不一致は拒否。使用済み判定より先に行い、
  -- 他人宛て招待の状態を漏らさない）
  if v_email is null or v_email <> lower(inv.email) then
    raise exception 'ログイン中のアカウントのメールアドレスが招待の宛先と一致しません'
      using errcode = '42501';
  end if;
  if inv.accepted_at is not null then
    -- 冪等リトライ: 本人が受諾済みなら成功として返す。それ以外の使用済みは拒否。
    if inv.accepted_by = v_uid then
      return inv.household_id;
    end if;
    raise exception 'この招待は使用済みです' using errcode = 'P0002';
  end if;
  if inv.expires_at < now() then
    raise exception 'この招待は期限切れです' using errcode = 'P0002';
  end if;
  -- ユーザー単位で受諾を直列化する（membership / grant の重複作成レース防止）。
  perform pg_advisory_xact_lock(hashtext('accept_household_invite:' || v_uid::text));

  if inv.role like 'guest:%' then
    -- ゲスト招待: household_members ではなく guest_grants を作成する（UC-G01）。
    -- scope_pet_id の FK は on delete cascade のため、ペットが消えた招待は行ごと
    -- 消えて上の「見つかりません」になる。ここの検証は世帯不整合の防衛線。
    if inv.scope_pet_id is null or not exists (
      select 1 from public.pets p
      where p.id = inv.scope_pet_id and p.household_id = inv.household_id
    ) then
      raise exception 'この招待の対象ペットは既に存在しません' using errcode = 'P0002';
    end if;
    -- 世帯メンバーへのゲスト付与は不要（メンバーの方が広い権限を持つ）
    if exists (
      select 1 from public.household_members m
      where m.household_id = inv.household_id and m.user_id = v_uid
    ) then
      raise exception '既にこの世帯のメンバーのため、ゲストとして参加する必要はありません'
        using errcode = 'P0001';
    end if;
    insert into public.guest_grants
      (household_id, user_id, scope_pet_id, role, valid_from, valid_to, created_by)
    values
      (inv.household_id, v_uid, inv.scope_pet_id, inv.role,
       coalesce(inv.valid_from, current_date), inv.valid_to, inv.invited_by);
  else
    -- 内部招待: 既にメンバーなら冪等に成功扱い。複数世帯への参加は可（D2 解除済み）。
    if not exists (
      select 1 from public.household_members m
      where m.household_id = inv.household_id and m.user_id = v_uid
    ) then
      insert into public.household_members (household_id, user_id, role)
      values (inv.household_id, v_uid, inv.role);
    end if;
  end if;

  update public.household_invites
    set accepted_at = now(), accepted_by = v_uid
    where id = inv.id;

  return inv.household_id;
end;
$$;

comment on function public.accept_household_invite(text) is
  '招待トークンを検証（未失効・期限内・宛先メール一致 D12/D13）して、内部招待はメンバー化・ゲスト招待（guest:*）は guest_grants を作成する唯一の経路。SECURITY DEFINER + search_path 固定。';

-- ---------------------------------------------------------------
-- 3. get_household_guests: ゲスト一覧の表示用（メール解決つき・owner 限定）
--    auth.users は個人スコープ（UC-M03）のため、get_household_members と同様に
--    SECURITY DEFINER 経由で最小限（メールのみ）を返す。
-- ---------------------------------------------------------------
create or replace function public.get_household_guests(p_household uuid)
returns table (
  id           uuid,
  user_id      uuid,
  email        text,
  scope_pet_id uuid,
  role         text,
  valid_from   date,
  valid_to     date,
  revoked_at   timestamptz,
  created_at   timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.has_household_role(p_household, array['owner']) then
    raise exception 'この操作は世帯の owner のみ行えます' using errcode = '42501';
  end if;

  return query
  select g.id, g.user_id, u.email::text, g.scope_pet_id, g.role,
         g.valid_from, g.valid_to, g.revoked_at, g.created_at
  from public.guest_grants g
  join auth.users u on u.id = g.user_id
  where g.household_id = p_household
  order by g.created_at desc;
end;
$$;

comment on function public.get_household_guests(uuid) is
  '世帯のゲスト付与一覧（ゲストのメールつき）。owner のみ。auth.users を個人スコープのまま保つための SECURITY DEFINER 経路。';

revoke all on function public.get_household_guests(uuid) from public;
grant execute on function public.get_household_guests(uuid) to authenticated;
