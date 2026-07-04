-- =============================================================
-- mfmf / Phase 3.5 S3 (Issue #45) — 内部招待その1: household_invites + 受諾フロー
--
-- 世帯へのメンバー追加を「招待 → 受諾」でのみ可能にする（UC-O09〜O11）。
--   - 宛先メール固定（D12）: 招待は特定メールアドレス宛て。受諾時に「ログイン中
--     アカウントのメール = 宛先」を要求する（D13: 一致すればワンクリック参加、
--     不一致は拒否 = 別アカウントでの誤受諾防止）。オープンリンクは採らない。
--   - 受諾でのみメンバー化: household_members への insert ポリシーは引き続き
--     deny by default（自己昇格不可 UC-A05）。受諾は SECURITY DEFINER の
--     accept_household_invite() だけが行う（検証をすべて通った場合のみ）。
--   - 期限・失効・取消（UC-O11): expires_at / revoked_at / accepted_at で管理。
--     取消・再送は owner が行う（invites の RLS は owner のみ write）。
--   - 招待 role は editor / viewer のみ（owner の追加は加入後に UC-H04 で昇格。
--     招待経路からの owner 直付与は事故・乗っ取り面のリスクが大きい）。
--
-- ロールバック手順（本 migration を取り消す場合）:
--   drop function if exists public.accept_household_invite(text);
--   drop table if exists public.household_invites;
-- =============================================================

create table if not exists public.household_invites (
  id            uuid        primary key default gen_random_uuid(),
  household_id  uuid        not null references public.households (id) on delete cascade,
  email         text        not null,
  role          text        not null default 'editor'
                            check (role in ('editor', 'viewer')),
  token         text        not null unique,
  invited_by    uuid        not null references auth.users (id) on delete cascade,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  accepted_at   timestamptz,
  accepted_by   uuid        references auth.users (id) on delete set null,
  revoked_at    timestamptz,
  constraint household_invites_email_not_blank check (char_length(btrim(email)) between 3 and 255)
);

comment on table public.household_invites is
  '世帯への招待（宛先メール固定 D12。受諾でのみ household_members へ追加される）';
comment on column public.household_invites.token is
  '推測不能なランダムトークン（招待リンクに載る。受諾時はメール一致も要求 D13）';

create index if not exists household_invites_household_idx
  on public.household_invites (household_id, created_at desc);
create index if not exists household_invites_email_idx
  on public.household_invites (lower(email));

alter table public.household_invites enable row level security;

-- owner のみが自世帯の招待を管理できる（発行・取消・削除・一覧）。
drop policy if exists "invites_select_owner" on public.household_invites;
create policy "invites_select_owner"
  on public.household_invites for select
  using (public.has_household_role(household_id, array['owner']));

drop policy if exists "invites_insert_owner" on public.household_invites;
create policy "invites_insert_owner"
  on public.household_invites for insert
  with check (
    invited_by = auth.uid()
    and public.has_household_role(household_id, array['owner'])
  );

drop policy if exists "invites_update_owner" on public.household_invites;
create policy "invites_update_owner"
  on public.household_invites for update
  using (public.has_household_role(household_id, array['owner']))
  with check (public.has_household_role(household_id, array['owner']));

drop policy if exists "invites_delete_owner" on public.household_invites;
create policy "invites_delete_owner"
  on public.household_invites for delete
  using (public.has_household_role(household_id, array['owner']));

-- 被招待者は「自分のメール宛て」の招待を閲覧できる（受諾画面の表示用。
-- token を知らなくても自分宛て招待の存在は本人に見せてよい）。
drop policy if exists "invites_select_invitee" on public.household_invites;
create policy "invites_select_invitee"
  on public.household_invites for select
  using (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));

grant select, insert, update, delete on public.household_invites to authenticated;
grant all on public.household_invites to service_role;

-- ---------------------------------------------------------------
-- 受諾: accept_household_invite(p_token)
--   検証（token 実在・未失効・未受諾・期限内・メール一致 D12/D13）をすべて通った
--   場合のみ household_members へ追加する。household_members の insert ポリシーは
--   deny by default のまま（この関数だけが SECURITY DEFINER で書ける = UC-A05 維持）。
--   世帯切替 UI 導入（D2・UC-H08）までは「既に他世帯に所属しているユーザー」の
--   受諾を 1 世帯に制限する（見えないデータの発生を防ぐ）。
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
    -- 冪等リトライ: 本人が受諾済み（成功後のタイムアウト再試行・リンク再訪）は
    -- 失敗ではなく成功として返す。それ以外の使用済みは拒否。
    if inv.accepted_by = v_uid then
      return inv.household_id;
    end if;
    raise exception 'この招待は使用済みです' using errcode = 'P0002';
  end if;
  if inv.expires_at < now() then
    raise exception 'この招待は期限切れです' using errcode = 'P0002';
  end if;
  -- ユーザー単位で受諾を直列化する（異なる招待の同時受諾で D2 の単一世帯制限を
  -- すり抜けて複数 membership が作られるレースを防ぐ）。
  perform pg_advisory_xact_lock(hashtext('accept_household_invite:' || v_uid::text));
  -- 既にメンバーなら冪等に成功扱い（受諾済みマークだけ付ける）
  if not exists (
    select 1 from public.household_members m
    where m.household_id = inv.household_id and m.user_id = v_uid
  ) then
    -- D2: 世帯切替 UI 導入までは複数世帯への参加を制限する
    if exists (select 1 from public.household_members m where m.user_id = v_uid) then
      raise exception '現在は複数の世帯に参加できません（世帯切替機能の提供後に解禁されます）'
        using errcode = 'P0001';
    end if;
    insert into public.household_members (household_id, user_id, role)
    values (inv.household_id, v_uid, inv.role);
  end if;

  update public.household_invites
    set accepted_at = now(), accepted_by = v_uid
    where id = inv.id;

  return inv.household_id;
end;
$$;

comment on function public.accept_household_invite(text) is
  '招待トークンを検証（未失効・期限内・宛先メール一致 D12/D13）してメンバー化する唯一の経路。SECURITY DEFINER + search_path 固定。household_members の insert deny by default（UC-A05）はこの関数で維持される。';

revoke all on function public.accept_household_invite(text) from public;
grant execute on function public.accept_household_invite(text) to authenticated;
