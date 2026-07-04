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

-- ---------------------------------------------------------------
-- share_links の世帯スコープ化（複数世帯解禁の前提）
--   get_shared_view は従来 owner_id だけで記録を集めていたため、複数世帯に所属する
--   作成者が発行したリンクは「その人が全世帯で書いた記録」を匿名公開してしまう。
--   リンクに household_id を持たせ、リンクの世帯の記録に限定する。
--   既存リンクは owner の既定世帯（バックフィルと同じタイブレーク）へ紐づける。
--   （share_links 自体は S4 #93 / D4 で guest_grants へ一本化・廃止予定）
-- ---------------------------------------------------------------
alter table public.share_links
  add column if not exists household_id uuid references public.households (id);

comment on column public.share_links.household_id is
  '共有対象の世帯。リンクはこの世帯の記録のみ返す（null は移行期の旧リンク = owner のみで絞る）';

do $$
declare
  r  record;
  hh uuid;
begin
  perform pg_advisory_xact_lock(20260704030000);
  for r in
    select distinct owner_id from public.share_links where household_id is null
  loop
    select m.household_id into hh
    from public.household_members m
    where m.user_id = r.owner_id
    order by (m.role = 'owner') desc, m.created_at, m.household_id
    limit 1;
    if hh is not null then
      update public.share_links
        set household_id = hh
        where owner_id = r.owner_id and household_id is null;
    end if;
  end loop;
end $$;

create or replace function public.get_shared_view(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  link  public.share_links;
  recs  jsonb;
begin
  select * into link
  from public.share_links
  where token = p_token
    and revoked_at is null
    and (expires_at is null or expires_at > now())
    -- 発行者がリンクの世帯を退出/削除されたら、そのリンクも自動的に無効化する
    -- （退出者は世帯データへのアクセスを失う = UC-H05/H06。リンク経由の残置も許さない。
    --   null は移行期の旧リンク = S4 の share_links 廃止 D4 で一掃する）
    and (household_id is null
         or public.is_household_member(household_id, owner_id));

  if not found then
    return jsonb_build_object('valid', false);
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'record_date', record_date,
        'source',      source,
        'author',      author,
        'weight_kg',   weight_kg,
        'body',        body
      )
      order by record_date desc, created_at desc
    ),
    '[]'::jsonb
  )
  into recs
  from public.daycare_records
  where owner_id = link.owner_id
    -- リンクの世帯の記録のみ（null は移行期の旧リンク = 従来どおり owner のみで絞る）
    and (link.household_id is null or household_id = link.household_id)
    and (link.from_date is null or record_date >= link.from_date)
    and (link.to_date   is null or record_date <= link.to_date);

  return jsonb_build_object(
    'valid',   true,
    'label',   link.label,
    'records', recs
  );
end;
$$;

-- share_links の書き込みポリシーを世帯整合で強化する。
-- insert: household_id を必須にし、「その世帯で editor+」であることを要求
--   （null で作ると get_shared_view の移行期分岐（owner のみで絞る）に乗り、
--   直接 API 経由で全世帯の自筆記録を公開できてしまうため。20260703170000 の
--   「どこかの世帯で editor+」より厳密化）。
-- update: revoke（失効）以外の変更も同じ整合を要求（リンクの household_id を
--   自分が editor+ でない世帯へ付け替える・null へ戻す経路を閉じる）。
drop policy if exists "share_links_insert_own" on public.share_links;
create policy "share_links_insert_own"
  on public.share_links for insert
  with check (
    auth.uid() = owner_id
    and household_id is not null
    and public.has_household_role(household_id, array['owner','editor'])
  );

drop policy if exists "share_links_update_own" on public.share_links;
create policy "share_links_update_own"
  on public.share_links for update
  using (auth.uid() = owner_id)
  with check (
    auth.uid() = owner_id
    and (
      revoked_at is not null
      or (
        household_id is not null
        and public.has_household_role(household_id, array['owner','editor'])
      )
    )
  );
