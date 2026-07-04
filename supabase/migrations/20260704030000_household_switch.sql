-- =============================================================
-- mfmf / Phase 3.5 S3 (Issue #45) — 内部招待その3: 世帯切替の解禁（D2）とメンバー表示
--
-- D2:「世帯切替 UI は S3 招待と同時に導入。切替 UI が無い状態で多世帯招待を許すと
--     『見えないデータ』が生じる」— 本 PR でアプリに切替 UI（Cookie ベースの
--     現在世帯・UC-H08）が入るため、受諾関数の単一世帯制限を撤廃し、
--     1 ユーザー × 複数世帯（UC-H07・D1）を解禁する。
--
--   1. accept_household_invite: 「既に他世帯に所属していると受諾不可（P0001）」の
--      ガードを撤廃（他の検証・ユーザー単位の直列化・冪等リトライは不変更）。
--   2. get_household_members(p_household): メンバー一覧にメール・表示名を出すための
--      SECURITY DEFINER 関数。auth.users(email) / profiles(display_name) は個人スコープ
--      （UC-M03）のため RLS では世帯共有しない。この関数だけが「呼び出しユーザーが
--      その世帯のメンバーである場合」に限り、当該世帯メンバーの最小限の情報
--      （user_id・role・email・表示名）を返す。
--
-- ロールバック手順（本 migration を取り消す場合）:
--   drop function if exists public.get_household_members(uuid);
--   accept_household_invite を 20260704010000 の定義（D2 ガードつき）で再作成する。
-- =============================================================

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
  -- ユーザー単位で受諾を直列化する（membership の重複作成レース防止）。
  perform pg_advisory_xact_lock(hashtext('accept_household_invite:' || v_uid::text));
  -- 既にメンバーなら冪等に成功扱い。複数世帯への参加は D2 解除により許可
  -- （切替 UI = Cookie ベースの現在世帯 UC-H08 とセットで解禁）。
  if not exists (
    select 1 from public.household_members m
    where m.household_id = inv.household_id and m.user_id = v_uid
  ) then
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
  '招待トークンを検証（未失効・期限内・宛先メール一致 D12/D13）してメンバー化する唯一の経路。複数世帯への参加可（D2 は切替 UI とセットで解除済み）。SECURITY DEFINER + search_path 固定。';

-- ---------------------------------------------------------------
-- get_household_members: メンバー一覧の表示用（メール・表示名つき）
-- ---------------------------------------------------------------
create or replace function public.get_household_members(p_household uuid)
returns table (
  user_id      uuid,
  role         text,
  created_at   timestamptz,
  email        text,
  display_name text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  -- 呼び出しユーザーが当該世帯のメンバーであることを必須にする（非メンバーには
  -- メンバー構成もメールも一切返さない）。
  if not public.has_household_role(p_household) then
    raise exception 'この世帯のメンバーではありません' using errcode = '42501';
  end if;

  return query
  select m.user_id, m.role, m.created_at, u.email::text, p.display_name
  from public.household_members m
  join auth.users u on u.id = m.user_id
  left join public.profiles p on p.owner_id = m.user_id
  where m.household_id = p_household
  order by m.created_at;
end;
$$;

comment on function public.get_household_members(uuid) is
  '世帯メンバー一覧（メール・表示名つき）。呼び出しユーザーが当該世帯のメンバーの場合のみ返す。auth.users / profiles は個人スコープ（UC-M03）のままにするための SECURITY DEFINER 経路。';

revoke all on function public.get_household_members(uuid) from public;
grant execute on function public.get_household_members(uuid) to authenticated;
