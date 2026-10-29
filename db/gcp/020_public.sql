-- Reviewed GCP baseline: source public schema at repository f69dc9a697ec4fdd85c6a00555ffa894bc1a5210.
-- Source: isolated PostgreSQL 17, ALL source migrations through 20261028010000.
-- Reproduced using tests/gcp/source-shim.sql only in the source proof database.
-- No source data is included. Apply only to an empty database after 010_identity.sql.
-- All 20 public tables / 70 policies retained; one obsolete Storage trigger function removed.
-- Differences: GCS-only state, explicit operator role, GCS ledger household guard,
-- auth deletion trigger, and least-privilege ACLs supplied separately in 030_permissions.sql.
-- Historical Supabase migrations remain unchanged and are NOT replayed here.

--
-- PostgreSQL database dump
--


-- Dumped from database version 17.11 (Debian 17.11-1.pgdg12+2)
-- Dumped by pg_dump version 17.11 (Debian 17.11-1.pgdg12+2)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = on;

--
-- Name: accept_household_invite(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.accept_household_invite(p_token text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: FUNCTION accept_household_invite(p_token text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.accept_household_invite(p_token text) IS '招待トークンを検証（未失効・期限内・宛先メール一致 D12/D13）して、内部招待はメンバー化・ゲスト招待（guest:*）は guest_grants を作成する唯一の経路。SECURITY DEFINER + search_path 固定。';


--
-- Name: cancel_media_upload(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cancel_media_upload(p_asset_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare v_asset public.media_assets;
begin
  if auth.uid() is null then raise exception 'Media access denied' using errcode = '42501'; end if;
  if public.get_media_storage_mode() <> 'gcs' then raise exception 'Media writes are unavailable' using errcode = '55000'; end if;
  select * into v_asset from public.media_assets where id = p_asset_id for update;
  if not found or v_asset.created_by is distinct from auth.uid() or v_asset.is_legacy then raise exception 'Media access denied' using errcode = '42501'; end if;
  if v_asset.state = 'ready' then raise exception 'Published media cannot be cancelled' using errcode = '55000'; end if;
  if v_asset.state = 'reserved' then
    update public.media_assets set state = 'deleted', deleted_at = now() where id = v_asset.id returning * into v_asset;
  end if;
  return to_jsonb(v_asset);
end;
$$;


--
-- Name: commit_media_upload(uuid, text, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.commit_media_upload(p_asset_id uuid, p_generation text, p_expected_old_path text DEFAULT NULL::text, p_expected_old_asset_id uuid DEFAULT NULL::uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare v_asset public.media_assets; v_target record; v_path text; v_old uuid; v_retired jsonb;
begin
  if auth.uid() is null then raise exception 'Media access denied' using errcode = '42501'; end if;
  if public.get_media_storage_mode() <> 'gcs' then raise exception 'Media writes are unavailable' using errcode = '55000'; end if;
  if p_generation is null or p_generation !~ '^[1-9][0-9]{0,19}$' then raise exception 'Invalid generation' using errcode = '22023'; end if;
  select * into v_asset from public.media_assets where id = p_asset_id;
  if not found or v_asset.created_by is distinct from auth.uid() or v_asset.is_legacy then raise exception 'Media access denied' using errcode = '42501'; end if;
  if v_asset.state = 'deleted' then raise exception 'Media asset is deleted' using errcode = '55000'; end if;
  select * into v_target from public.media_write_target(v_asset.kind, v_asset.entity_id, v_asset.household_id, false);
  if v_asset.owner_id is distinct from v_target.target_owner then raise exception 'Media target changed' using errcode = '55000'; end if;
  if v_asset.kind = 'profile' then
    -- Profile settings are optional; a first avatar creates only the user's own row.
    insert into public.profiles(owner_id) values (v_asset.entity_id) on conflict (owner_id) do nothing;
    select avatar_path, avatar_asset_id into v_path, v_old from public.profiles where owner_id = v_asset.entity_id for update;
  elsif v_asset.kind = 'household' then
    select avatar_path, avatar_asset_id into v_path, v_old from public.households where id = v_asset.entity_id for update;
  elsif v_asset.kind = 'pet' then
    select avatar_path, avatar_asset_id into v_path, v_old from public.pets where id = v_asset.entity_id for update;
  end if;
  select * into v_asset from public.media_assets where id = p_asset_id for update;
  if v_asset.state = 'deleted' then raise exception 'Media asset is deleted' using errcode = '55000'; end if;
  if v_asset.state = 'ready' then
    if v_asset.generation = p_generation and ((v_asset.kind = 'photo' and exists (
      select 1 from public.record_photos where id = v_asset.id and media_asset_id = v_asset.id and record_id = v_asset.entity_id
    )) or (v_asset.kind <> 'photo' and v_old = v_asset.id and v_path = v_asset.final_key)) then
      return jsonb_build_object('asset',to_jsonb(v_asset),'retired_assets','[]'::jsonb);
    end if;
    raise exception 'Media asset cannot be republished' using errcode = '55000';
  end if;
  if v_asset.expires_at <= now() then raise exception 'Media upload expired' using errcode = '55000'; end if;
  if v_asset.kind <> 'photo' and (v_path is distinct from p_expected_old_path or v_old is distinct from p_expected_old_asset_id) then
    raise exception 'Avatar changed; reload before retrying' using errcode = '40001';
  end if;
  update public.media_assets set state = 'ready', generation = p_generation where id = v_asset.id returning * into v_asset;
  if v_asset.kind = 'photo' then
    insert into public.record_photos(id,record_id,household_id,storage_path,media_asset_id)
      values (v_asset.id,v_asset.entity_id,v_asset.household_id,v_asset.final_key,v_asset.id);
  elsif v_asset.kind = 'profile' then
    update public.profiles set avatar_path = v_asset.final_key, avatar_asset_id = v_asset.id where owner_id = v_asset.entity_id;
  elsif v_asset.kind = 'household' then
    update public.households set avatar_path = v_asset.final_key, avatar_asset_id = v_asset.id where id = v_asset.entity_id;
  else
    update public.pets set avatar_path = v_asset.final_key, avatar_asset_id = v_asset.id where id = v_asset.entity_id;
  end if;
  v_retired := public.media_retire_unreferenced(v_old);
  return jsonb_build_object('asset',to_jsonb(v_asset),'retired_assets',case when v_retired is null then '[]'::jsonb else jsonb_build_array(v_retired) end);
end;
$_$;


--
-- Name: create_own_household(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_own_household(p_name text DEFAULT ''::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_uid uuid := auth.uid();
  v_id  uuid;
begin
  if v_uid is null then
    raise exception 'ログインが必要です' using errcode = '42501';
  end if;

  -- ユーザー単位で直列化する（二重送信・並行タブで世帯が 2 つできるレース防止。
  -- accept_household_invite と同じキー体系で、招待受諾との並行実行も直列化する）。
  perform pg_advisory_xact_lock(hashtext('accept_household_invite:' || v_uid::text));

  -- 所属ゼロのユーザー専用（オンボーディング導線）。既にどこかの世帯に所属して
  -- いる場合は作成させない（追加参加は招待受諾のみ）。
  if exists (
    select 1 from public.household_members m where m.user_id = v_uid
  ) then
    raise exception '既に世帯に所属しています（新しい世帯への参加は招待から行えます）'
      using errcode = 'P0001';
  end if;

  insert into public.households (name)
  values (coalesce(trim(p_name), ''))
  returning id into v_id;

  insert into public.household_members (household_id, user_id, role)
  values (v_id, v_uid, 'owner');

  return v_id;
end;
$$;


--
-- Name: FUNCTION create_own_household(p_name text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.create_own_household(p_name text) IS '未所属ユーザーが新世帯を作成して owner になる唯一の経路（D7 / UC-O03）。所属ゼロの場合のみ作成可。SECURITY DEFINER + search_path 固定。';


--
-- Name: delete_media_reference(text, uuid, uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delete_media_reference(p_kind text, p_entity_id uuid, p_photo_id uuid DEFAULT NULL::uuid, p_expected_asset_id uuid DEFAULT NULL::uuid, p_expected_old_path text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare v_hh uuid; v_path text; v_old uuid; v_retired jsonb;
begin
  if auth.uid() is null then raise exception 'Media access denied' using errcode = '42501'; end if;
  if public.get_media_storage_mode() <> 'gcs' then raise exception 'Media writes are unavailable' using errcode = '55000'; end if;
  if p_kind = 'photo' then
    select r.household_id into v_hh from public.daycare_records r where r.id = p_entity_id;
  elsif p_kind = 'pet' then select p.household_id into v_hh from public.pets p where p.id = p_entity_id;
  elsif p_kind = 'household' then v_hh := p_entity_id;
  elsif p_kind <> 'profile' or p_kind is null then raise exception 'Invalid media kind' using errcode = '22023';
  end if;
  perform * from public.media_write_target(p_kind,p_entity_id,v_hh,false);
  if p_kind = 'photo' then
    select storage_path,media_asset_id into v_path,v_old from public.record_photos
      where id = p_photo_id and record_id = p_entity_id for update;
    if not found then raise exception 'Media access denied' using errcode = '42501'; end if;
  else
    if p_photo_id is not null then raise exception 'Invalid media target' using errcode = '22023'; end if;
    if p_kind = 'profile' then
      select avatar_path,avatar_asset_id into v_path,v_old from public.profiles where owner_id = p_entity_id for update;
    elsif p_kind = 'household' then
      select avatar_path,avatar_asset_id into v_path,v_old from public.households where id = p_entity_id for update;
    else
      select avatar_path,avatar_asset_id into v_path,v_old from public.pets where id = p_entity_id for update;
    end if;
    if not found then raise exception 'Media access denied' using errcode = '42501'; end if;
  end if;
  if v_path is distinct from p_expected_old_path or v_old is distinct from p_expected_asset_id then
    raise exception 'Media changed; reload before retrying' using errcode = '40001';
  end if;
  if p_kind = 'photo' then delete from public.record_photos where id = p_photo_id and record_id = p_entity_id;
  elsif p_kind = 'profile' then update public.profiles set avatar_path = null, avatar_asset_id = null where owner_id = p_entity_id;
  elsif p_kind = 'household' then update public.households set avatar_path = null, avatar_asset_id = null where id = p_entity_id;
  else update public.pets set avatar_path = null, avatar_asset_id = null where id = p_entity_id;
  end if;
  v_retired := public.media_retire_unreferenced(v_old);
  return jsonb_build_object('retired_assets',case when v_retired is null then '[]'::jsonb else jsonb_build_array(v_retired) end);
end;
$$;


--
-- Name: delete_own_household(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delete_own_household(p_household_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'ログインが必要です' using errcode = '42501';
  end if;

  -- 空判定より前に世帯行をロックし、チェック→削除を FK 子テーブルに対して
  -- アトミックにする（詳しい理由は 20260705040000_household_delete.sql のコメント）。
  perform 1 from public.households where id = p_household_id for update;

  if not exists (
    select 1 from public.household_members m
    where m.household_id = p_household_id
      and m.user_id = v_uid
      and m.role = 'owner'
  ) then
    raise exception 'この世帯を削除できるのは owner だけです' using errcode = '42501';
  end if;

  -- 参照データのある世帯は削除しない（孤児化防止）。1 行でもあれば拒否。
  -- GCS reservations and ready assets must be retired before household deletion.
  if exists (select 1 from public.pets                where household_id = p_household_id)
     or exists (select 1 from public.daycare_records     where household_id = p_household_id)
     or exists (select 1 from public.record_photos       where household_id = p_household_id)
     or exists (select 1 from public.tags                where household_id = p_household_id)
     or exists (select 1 from public.feedback            where household_id = p_household_id)
     or exists (select 1 from public.household_invites   where household_id = p_household_id)
     or exists (select 1 from public.guest_grants        where household_id = p_household_id)
     or exists (select 1 from public.schedule_rules      where household_id = p_household_id)
     or exists (select 1 from public.schedule_rule_skips where household_id = p_household_id)
     or exists (
          select 1 from public.media_assets a
          where a.household_id = p_household_id and a.state <> 'deleted'
        ) then
    raise exception 'データのある世帯は削除できません。記録・写真・ペットなどのエクスポート後に削除する導線は準備中です（#51）'
      using errcode = 'P0001';
  end if;

  perform set_config('mfmf.deleting_household', p_household_id::text, true);
  delete from public.households where id = p_household_id;
  perform set_config('mfmf.deleting_household', '', true);
end;
$$;


--
-- Name: FUNCTION delete_own_household(p_household_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.delete_own_household(p_household_id uuid) IS 'owner が参照データの無い世帯を削除する（UC-H09 の部分集合）。毎週の予定ルール・打ち消しも「データあり」に数える。SECURITY DEFINER + search_path 固定。';


--
-- Name: delete_plan(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delete_plan(p_record uuid) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  v_household uuid;
  v_date      date;
  v_overrides boolean;
begin
  -- 消せるのは「予定」だけ。別のタブで完了された行をこの経路で消せると、
  -- 確認なしで記録と写真が消える
  select household_id, record_date, overrides_rule
    into v_household, v_date, v_overrides
    from public.daycare_records
   where id = p_record
     and status = 'planned';
  if v_household is null then
    raise exception '予定が見つかりません（すでに記録になっている可能性があります）'
      using errcode = '42501';
  end if;

  delete from public.daycare_records
   where id = p_record and status = 'planned';
  if not found then
    raise exception '予定を消せませんでした（権限がありません）' using errcode = '42501';
  end if;

  if v_overrides then
    insert into public.schedule_rule_skips (household_id, on_date, created_by)
    values (v_household, v_date, auth.uid())
    on conflict (household_id, on_date) do nothing;
  end if;
end;
$$;


--
-- Name: FUNCTION delete_plan(p_record uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.delete_plan(p_record uuid) IS '予定を消す。ルールを置き換えていた行なら、その日の打ち消しも同じトランザクションで入れる。RLS は呼び出しユーザーのまま効く';


--
-- Name: delete_record_keeping_skip(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delete_record_keeping_skip(p_record uuid) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  v_household uuid;
  v_date      date;
  v_overrides boolean;
begin
  select household_id, record_date, overrides_rule
    into v_household, v_date, v_overrides
    from public.daycare_records
   where id = p_record;
  if v_household is null then
    raise exception '記録が見つかりません（または権限がありません）' using errcode = '42501';
  end if;

  delete from public.daycare_records where id = p_record;
  if not found then
    raise exception '記録を消せませんでした（権限がありません）' using errcode = '42501';
  end if;

  if v_overrides then
    insert into public.schedule_rule_skips (household_id, on_date, created_by)
    values (v_household, v_date, auth.uid())
    on conflict (household_id, on_date) do nothing;
  end if;
end;
$$;


--
-- Name: FUNCTION delete_record_keeping_skip(p_record uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.delete_record_keeping_skip(p_record uuid) IS '記録を消す。ルールを置き換えていた行なら、その日の打ち消しも同じトランザクションで入れる';


--
-- Name: enforce_last_owner(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_last_owner() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  remaining integer;
begin
  -- 世帯そのものの削除（delete_own_household RPC 経由）では、cascade で消える owner 行に
  -- 対して「最低 1 人の owner」を要求しない（世帯が消えるので守るべき世帯が無い）。
  -- GUC は当該 RPC だけがセットする（クライアントからは設定不能）。household_id 一致で限定。
  if tg_op = 'DELETE'
     and nullif(current_setting('mfmf.deleting_household', true), '') = old.household_id::text then
    return old;
  end if;

  if tg_op = 'UPDATE'
     and (new.household_id <> old.household_id or new.user_id <> old.user_id) then
    raise exception 'household_members の household_id / user_id は変更できません（行の削除と追加で表現してください）';
  end if;

  if (tg_op = 'DELETE' and old.role = 'owner')
     or (tg_op = 'UPDATE' and old.role = 'owner' and new.role <> 'owner') then
    -- 同一世帯の owner 数変更を直列化する（親 households 行のロック）。
    perform 1 from public.households h where h.id = old.household_id for update;
    select count(*) into remaining
    from public.household_members m
    where m.household_id = old.household_id
      and m.role = 'owner'
      and m.user_id <> old.user_id;
    if remaining = 0 then
      raise exception '世帯には最低 1 人の owner が必要です（最後の owner は降格・削除・退出できません / D6）';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;


--
-- Name: FUNCTION enforce_last_owner(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.enforce_last_owner() IS '世帯の owner 数 ≥ 1 を強制する（D6・世帯の孤児化防止）。ただし delete_own_household 経由の世帯ごと削除（GUC mfmf.deleting_household 一致）は素通りさせる。household_id / user_id の付け替えも禁止。SECURITY DEFINER + search_path 固定。';


--
-- Name: forbid_owner_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.forbid_owner_change() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if new.owner_id <> old.owner_id then
    raise exception 'owner_id（作成者）は変更できません' using errcode = '42501';
  end if;
  return new;
end;
$$;


--
-- Name: FUNCTION forbid_owner_change(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.forbid_owner_change() IS 'owner_id 列の変更を禁止する（帰属のすり替え防止。S3 の読取述語緩和とセット）';


--
-- Name: get_household_guests(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_household_guests(p_household uuid) RETURNS TABLE(id uuid, user_id uuid, email text, scope_pet_id uuid, role text, valid_from date, valid_to date, revoked_at timestamp with time zone, created_at timestamp with time zone)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: FUNCTION get_household_guests(p_household uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_household_guests(p_household uuid) IS '世帯のゲスト付与一覧（ゲストのメールつき）。owner のみ。auth.users を個人スコープのまま保つための SECURITY DEFINER 経路。';


--
-- Name: get_household_members(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_household_members(p_household uuid) RETURNS TABLE(user_id uuid, role text, created_at timestamp with time zone, email text, display_name text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: FUNCTION get_household_members(p_household uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_household_members(p_household uuid) IS '世帯メンバー一覧（メール・表示名つき）。呼び出しユーザーが当該世帯のメンバーの場合のみ返す。auth.users / profiles は個人スコープ（UC-M03）のままにするための SECURITY DEFINER 経路。';


--
-- Name: get_media_read_backend(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_media_read_backend() RETURNS text
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select read_backend from public.media_storage_state where singleton;
$$;


--
-- Name: get_media_storage_mode(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_media_storage_mode() RETURNS text
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select coalesce((select mode from public.media_storage_state where singleton),'frozen');
$$;


--
-- Name: get_media_upload(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_media_upload(p_asset_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare v_asset public.media_assets; v_uid uuid := auth.uid();
begin
  select * into v_asset from public.media_assets where id = p_asset_id;
  if v_uid is null or not found or not (
    (v_asset.kind = 'profile' and v_asset.owner_id = v_uid)
    or (v_asset.kind <> 'profile' and public.has_household_role(v_asset.household_id))
  ) then raise exception 'Media access denied' using errcode = '42501'; end if;
  return to_jsonb(v_asset);
end;
$$;


--
-- Name: has_guest_access(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.has_guest_access(p_household uuid, p_pet uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: FUNCTION has_guest_access(p_household uuid, p_pet uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.has_guest_access(p_household uuid, p_pet uuid) IS '呼び出しユーザーが当該世帯の当該ペットに「今日」有効なゲスト付与を持つか（UC-G02/G04）';


--
-- Name: has_guest_record_access(uuid, uuid, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.has_guest_record_access(p_household uuid, p_pet uuid, p_record_date date) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: FUNCTION has_guest_record_access(p_household uuid, p_pet uuid, p_record_date date); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.has_guest_record_access(p_household uuid, p_pet uuid, p_record_date date) IS 'ゲストの記録アクセス判定: 付与が今日有効 かつ 記録日が付与期間内（UC-G02/G03/G04・D8）';


--
-- Name: has_household_role(uuid, text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.has_household_role(target_household uuid, allowed_roles text[] DEFAULT NULL::text[]) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select exists (
    select 1
    from public.household_members m
    where m.household_id = target_household
      and m.user_id = auth.uid()
      and (
        allowed_roles is null
        or cardinality(allowed_roles) = 0
        or m.role = any (allowed_roles)
      )
  );
$$;


--
-- Name: FUNCTION has_household_role(target_household uuid, allowed_roles text[]); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.has_household_role(target_household uuid, allowed_roles text[]) IS '呼び出しユーザー(auth.uid())が target_household のメンバーか（allowed_roles 指定時はそのロールのいずれかを持つか）を返す。SECURITY DEFINER + search_path 固定で household_members の RLS を迂回し再帰を防ぐ。RLS ポリシーから利用する。';


--
-- Name: is_household_member(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_household_member(target_household uuid, target_user uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select exists (
    select 1
    from public.household_members m
    where m.household_id = target_household
      and m.user_id = target_user
  );
$$;


--
-- Name: FUNCTION is_household_member(target_household uuid, target_user uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.is_household_member(target_household uuid, target_user uuid) IS '任意のユーザー target_user が target_household のメンバーかを返す。行の owner_id ∈ household_id 整合を RLS ポリシーで強制する用途。SECURITY DEFINER + search_path 固定で household_members の RLS を迂回し再帰を防ぐ。';


--
-- Name: jst_today(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.jst_today() RETURNS date
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$ select (now() at time zone 'Asia/Tokyo')::date $$;


--
-- Name: FUNCTION jst_today(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.jst_today() IS 'アプリと同じ「今日」（Asia/Tokyo）。RLS の日付判定に使う';


--
-- Name: media_account_deleted(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.media_account_deleted() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare v_id uuid;
begin
  for v_id in select id from public.media_assets where state <> 'deleted'
    and ((kind = 'profile' and entity_id = old.id) or (created_by = old.id and state = 'reserved'))
    order by id loop
    perform public.media_retire_unreferenced(v_id);
  end loop;
  return old;
end;
$$;


--
-- Name: media_assets_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.media_assets_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if tg_op = 'DELETE' then raise exception 'Media tombstones cannot be removed' using errcode = '55000'; end if;
  if tg_op = 'UPDATE' then
    if old.state = 'deleted' and new is distinct from old then raise exception 'Media asset is deleted' using errcode = '55000'; end if;
    if (to_jsonb(new) - array['state','generation','deleted_at']) is distinct from
       (to_jsonb(old) - array['state','generation','deleted_at']) then
      raise exception 'Media identity is immutable' using errcode = '55000';
    end if;
    if (old.state = 'ready' and new.state not in ('ready','deleted'))
      or (old.state = 'ready' and new.generation is distinct from old.generation) then
      raise exception 'Media asset cannot be republished' using errcode = '55000';
    end if;
  end if;
  if not public.media_is_operator() and public.get_media_storage_mode() <> 'gcs' then
    raise exception 'Media writes are unavailable' using errcode = '55000';
  end if;
  return new;
end;
$$;


--
-- Name: media_is_operator(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.media_is_operator() RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select auth.uid() is null
    and pg_catalog.pg_has_role(session_user, 'media_operator', 'MEMBER');
$$;


--
-- Name: media_parent_deleted(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.media_parent_deleted() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare v_kind text; v_entity uuid; v_id uuid;
begin
  v_kind := case tg_table_name when 'daycare_records' then 'photo' when 'pets' then 'pet' when 'profiles' then 'profile' end;
  if tg_table_name = 'profiles' then v_entity := old.owner_id; else v_entity := old.id; end if;
  for v_id in select id from public.media_assets where kind = v_kind and entity_id = v_entity and state <> 'deleted' order by id loop
    perform public.media_retire_unreferenced(v_id);
  end loop;
  return old;
end;
$$;


--
-- Name: media_parent_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.media_parent_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if not public.media_is_operator() and public.get_media_storage_mode() = 'frozen' then
    if tg_op = 'DELETE' then
      raise exception 'Media writes are unavailable' using errcode = '55000';
    elsif tg_table_name = 'daycare_records' then
      if new.id is distinct from old.id or new.household_id is distinct from old.household_id or new.owner_id is distinct from old.owner_id then
        raise exception 'Media writes are unavailable' using errcode = '55000';
      end if;
    end if;
  end if;
  if tg_table_name = 'households' and tg_op = 'DELETE' then
    -- Also runs inside delete_own_household: its existing schedule/data checks stay intact.
    if old.avatar_path is not null or old.avatar_asset_id is not null
      or exists (select 1 from public.media_assets where household_id = old.id and state <> 'deleted') then
      raise exception 'Household has media assets or uploads' using errcode = '55000';
    end if;
  elsif tg_table_name in ('daycare_records','pets') and tg_op = 'UPDATE' then
    if (new.id is distinct from old.id or new.household_id is distinct from old.household_id or new.owner_id is distinct from old.owner_id)
      and exists (select 1 from public.media_assets where kind = (case when tg_table_name = 'pets' then 'pet' else 'photo' end) and entity_id = old.id and state <> 'deleted') then
      raise exception 'Media parent identity is immutable' using errcode = '55000';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;


--
-- Name: media_reference_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.media_reference_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare v_mode text := public.get_media_storage_mode(); v_id uuid; v_path text;
  v_kind text; v_entity uuid; v_hh uuid; v_owner uuid; v_photo_id uuid; v_asset public.media_assets;
begin
  if public.media_is_operator() then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;
  if v_mode = 'frozen' then raise exception 'Media writes are unavailable' using errcode = '55000'; end if;
  if tg_op = 'DELETE' then return old; end if;
  if tg_table_name = 'record_photos' then
    v_id := new.media_asset_id; v_path := new.storage_path; v_kind := 'photo'; v_entity := new.record_id; v_photo_id := new.id;
    select r.household_id, r.owner_id into v_hh, v_owner from public.daycare_records r where r.id = new.record_id;
    if new.household_id is distinct from v_hh then raise exception 'Media reference mismatch' using errcode = '23514'; end if;
  elsif tg_table_name = 'profiles' then
    v_id := new.avatar_asset_id; v_path := new.avatar_path; v_kind := 'profile'; v_entity := new.owner_id; v_owner := new.owner_id;
  elsif tg_table_name = 'households' then
    v_id := new.avatar_asset_id; v_path := new.avatar_path; v_kind := 'household'; v_entity := new.id; v_hh := new.id;
  elsif tg_table_name = 'pets' then
    v_id := new.avatar_asset_id; v_path := new.avatar_path; v_kind := 'pet'; v_entity := new.id; v_hh := new.household_id; v_owner := new.owner_id;
  end if;
  -- Supabase remains functional before cutover, but callers cannot plant asset IDs.
  if v_mode = 'supabase' then
    if v_id is not null then raise exception 'Media assets are not enabled' using errcode = '55000'; end if;
    return new;
  end if;
  if v_path is null and v_id is null and v_kind <> 'photo' then return new; end if;
  if v_path is null or v_id is null then raise exception 'Media reference mismatch' using errcode = '23514'; end if;
  select * into v_asset from public.media_assets where id = v_id for key share;
  if not found or v_asset.state <> 'ready' or v_asset.generation is null
    or v_asset.kind <> v_kind or v_asset.entity_id <> v_entity or v_asset.final_key <> v_path
    or v_asset.household_id is distinct from v_hh or v_asset.owner_id is distinct from v_owner
    or (v_kind = 'photo' and v_photo_id <> (case when v_asset.is_legacy then v_asset.legacy_reference_id else v_asset.id end)) then
    raise exception 'Media reference mismatch' using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: media_reference_retired(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.media_reference_retired() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare v_old uuid;
begin
  if tg_table_name = 'record_photos' then
    v_old := old.media_asset_id;
    if tg_op = 'UPDATE' and old.media_asset_id is not distinct from new.media_asset_id then return new; end if;
  else
    v_old := old.avatar_asset_id;
    if tg_op = 'UPDATE' and old.avatar_asset_id is not distinct from new.avatar_asset_id then return new; end if;
  end if;
  perform public.media_retire_unreferenced(v_old);
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;


--
-- Name: media_retire_unreferenced(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.media_retire_unreferenced(p_asset_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare v_asset public.media_assets;
begin
  if p_asset_id is null then return null; end if;
  select * into v_asset from public.media_assets where id = p_asset_id for update;
  if not found then return null; end if;
  if exists (select 1 from public.record_photos where media_asset_id = p_asset_id)
    or exists (select 1 from public.profiles where avatar_asset_id = p_asset_id)
    or exists (select 1 from public.households where avatar_asset_id = p_asset_id)
    or exists (select 1 from public.pets where avatar_asset_id = p_asset_id) then return null; end if;
  if v_asset.state <> 'deleted' then
    update public.media_assets set state = 'deleted', deleted_at = now() where id = p_asset_id returning * into v_asset;
  end if;
  return to_jsonb(v_asset);
end;
$$;


--
-- Name: media_write_target(text, uuid, uuid, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.media_write_target(p_kind text, p_entity_id uuid, p_household_id uuid, p_new_photo boolean DEFAULT false) RETURNS TABLE(target_household uuid, target_owner uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare v_uid uuid := auth.uid(); v_role text; v_hh uuid; v_owner uuid;
begin
  if v_uid is null or p_entity_id is null then raise exception 'Media access denied' using errcode = '42501'; end if;
  if p_kind = 'profile' then
    if p_entity_id <> v_uid or p_household_id is not null then raise exception 'Media access denied' using errcode = '42501'; end if;
    perform 1 from auth.users where id = v_uid for key share;
    if not found then raise exception 'Media access denied' using errcode = '42501'; end if;
    return query select null::uuid, v_uid; return;
  elsif p_kind = 'household' then
    v_hh := p_entity_id; v_owner := null;
  elsif p_kind = 'pet' then
    select p.household_id, p.owner_id into v_hh, v_owner from public.pets p where p.id = p_entity_id for update;
    if not found then raise exception 'Media access denied' using errcode = '42501'; end if;
  elsif p_kind = 'photo' then
    select r.household_id, r.owner_id into v_hh, v_owner from public.daycare_records r where r.id = p_entity_id for key share;
    if not found then
      if not p_new_photo or exists (select 1 from public.media_assets a where a.kind = 'photo'
        and a.entity_id = p_entity_id and (a.household_id is distinct from p_household_id or a.owner_id <> v_uid)) then
        raise exception 'Media access denied' using errcode = '42501';
      end if;
      v_hh := p_household_id; v_owner := v_uid;
    end if;
  else raise exception 'Invalid media kind' using errcode = '22023';
  end if;
  if v_hh is null or v_hh is distinct from p_household_id then raise exception 'Media access denied' using errcode = '42501'; end if;
  if p_kind = 'household' then
    perform 1 from public.households where id = v_hh for update;
  else
    perform 1 from public.households where id = v_hh for key share;
  end if;
  if not found then raise exception 'Media access denied' using errcode = '42501'; end if;
  select m.role into v_role from public.household_members m
    where m.household_id = v_hh and m.user_id = v_uid for share;
  if v_role is null or (p_kind = 'household' and v_role <> 'owner')
    or (p_kind <> 'household' and v_role not in ('owner','editor')) then
    raise exception 'Media access denied' using errcode = '42501';
  end if;
  return query select v_hh, v_owner;
end;
$$;


--
-- Name: prune_schedule_assignments(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prune_schedule_assignments() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  r record;
  v_new uuid;
begin
  -- 世帯ごと削除の途中（delete_own_household）では何もしない。
  -- ここで版を積むと、消えていく世帯に子行を作ってしまう
  if coalesce(current_setting('mfmf.deleting_household', true), '') = old.household_id::text then
    return old;
  end if;
  if not exists (select 1 from public.households where id = old.household_id) then
    return old;
  end if;

  delete from public.record_assignees a
   using public.daycare_records rec
   where a.record_id = rec.id
     and rec.household_id = old.household_id
     and rec.status = 'planned'
     and a.user_id = old.user_id;

  delete from public.schedule_rule_assignees a
   using public.schedule_rules s
   where a.rule_id = s.id
     and s.household_id = old.household_id
     and s.since >= v_today
     and a.user_id = old.user_id;

  for r in
    select distinct on (s.weekday) s.*
      from public.schedule_rules s
     where s.household_id = old.household_id
       and s.since < v_today
     order by s.weekday, s.since desc
  loop
    -- 墓標（kind is null）は担当を持たない
    continue when r.kind is null;
    continue when not exists (
      select 1 from public.schedule_rule_assignees a
       where a.rule_id = r.id and a.user_id = old.user_id
    );
    -- 今日からの版がすでにあるなら、上の delete で外れている
    continue when exists (
      select 1 from public.schedule_rules s2
       where s2.household_id = r.household_id
         and s2.weekday = r.weekday
         and s2.since = v_today
    );

    insert into public.schedule_rules
      (household_id, weekday, since, kind, start_time, end_time, created_by)
    values
      (r.household_id, r.weekday, v_today, r.kind, r.start_time, r.end_time, r.created_by)
    returning id into v_new;

    insert into public.schedule_rule_assignees (rule_id, role, user_id)
    select v_new, a.role, a.user_id
      from public.schedule_rule_assignees a
     where a.rule_id = r.id
       and a.user_id <> old.user_id;
  end loop;

  return old;
end;
$$;


--
-- Name: FUNCTION prune_schedule_assignments(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.prune_schedule_assignments() IS '世帯を抜けた人の担当を、これからの予定と今日からのルール版から外す（過去は書き換えない）。SECURITY DEFINER + search_path 固定';


--
-- Name: replace_schedule_rule(uuid, smallint, date, text, time without time zone, time without time zone, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.replace_schedule_rule(p_household uuid, p_weekday smallint, p_since date, p_kind text, p_start time without time zone, p_end time without time zone, p_assignees jsonb DEFAULT '{}'::jsonb) RETURNS uuid
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  v_id uuid;
begin
  delete from public.schedule_rules
   where household_id = p_household
     and weekday = p_weekday
     and since >= p_since;

  insert into public.schedule_rules
    (household_id, weekday, since, kind, start_time, end_time, created_by)
  values
    (p_household, p_weekday, p_since, p_kind, p_start, p_end, auth.uid())
  returning id into v_id;

  insert into public.schedule_rule_assignees (rule_id, role, user_id)
  select v_id, key, value::uuid
    from jsonb_each_text(coalesce(p_assignees, '{}'::jsonb))
   where value is not null and value <> '';

  return v_id;
end;
$$;


--
-- Name: FUNCTION replace_schedule_rule(p_household uuid, p_weekday smallint, p_since date, p_kind text, p_start time without time zone, p_end time without time zone, p_assignees jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.replace_schedule_rule(p_household uuid, p_weekday smallint, p_since date, p_kind text, p_start time without time zone, p_end time without time zone, p_assignees jsonb) IS '毎週のルールの版を差し替える（削除と作成を 1 トランザクションで行う）。RLS は呼び出しユーザーのまま効く';


--
-- Name: reserve_media_upload(text, uuid, uuid, bigint, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reserve_media_upload(p_kind text, p_entity_id uuid, p_household_id uuid, p_byte_size bigint, p_content_type text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare v_uid uuid := auth.uid(); v_target record; v_asset public.media_assets; v_id uuid := gen_random_uuid();
begin
  if v_uid is null then raise exception 'Media access denied' using errcode = '42501'; end if;
  if public.get_media_storage_mode() <> 'gcs' then raise exception 'Media writes are unavailable' using errcode = '55000'; end if;
  if p_kind is null or p_kind not in ('photo','profile','household','pet') or p_byte_size is null or p_byte_size <= 0
    or p_byte_size > (case when p_kind = 'photo' then 10485760 else 2097152 end)
    or p_content_type is null or p_content_type not in ('image/jpeg','image/png','image/gif','image/webp','image/avif') then
    raise exception 'Invalid media upload' using errcode = '22023';
  end if;
  -- Expired reservations do not consume active quota. The operator GC makes
  -- their tombstones permanent and deletes any delayed incoming/final objects.
  -- The hourly abuse limit still counts expired/cancelled requests.
  -- Serialize quotas across this user's tabs and across editors of a household.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('media-user:' || v_uid::text, 0));
  if p_household_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('media-household:' || p_household_id::text, 0));
  end if;
  select * into v_target from public.media_write_target(p_kind, p_entity_id, p_household_id, true);
  if (select count(*) from public.media_assets where created_by = v_uid and state = 'reserved' and expires_at > now()) >= 20
    or (select coalesce(sum(byte_size),0) from public.media_assets where created_by = v_uid and state = 'reserved' and expires_at > now()) + p_byte_size > 104857600
    or (select count(*) from public.media_assets where created_by = v_uid and not is_legacy and created_at > now() - interval '1 hour') >= 50
    or (v_target.target_household is not null and (select coalesce(sum(byte_size),0) from public.media_assets
      where household_id = v_target.target_household and (state = 'ready' or (state = 'reserved' and expires_at > now()))) + p_byte_size > 1073741824) then
    raise exception 'Media upload quota exceeded' using errcode = '54000';
  end if;
  insert into public.media_assets(id,kind,entity_id,household_id,owner_id,created_by,incoming_key,final_key,byte_size,content_type,expires_at)
    values (v_id,p_kind,p_entity_id,v_target.target_household,v_target.target_owner,v_uid,'_incoming/' || v_id::text,
      coalesce(v_target.target_household,v_target.target_owner)::text || '/' ||
      case when p_kind = 'photo' then p_entity_id::text else 'avatars' end || '/' || v_id::text,
      p_byte_size,p_content_type,now() + interval '15 minutes') returning * into v_asset;
  return to_jsonb(v_asset);
end;
$$;


--
-- Name: reserve_record_ranking(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reserve_record_ranking(p_household uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  caller uuid := auth.uid();
  instant timestamptz;
  today date;
  minute timestamptz;
  project_budget public.record_ranking_project_budget%rowtype;
  user_budget public.record_ranking_user_budget%rowtype;
  project_daily integer;
  user_daily integer;
  user_minute integer;
begin
  if caller is null or p_household is null then
    raise exception 'Ranking access denied' using errcode = '42501';
  end if;
  -- Lock membership during the reservation. Guest grants are deliberately not accepted.
  perform 1 from public.household_members
    where household_id = p_household and user_id = caller
      and role in ('owner', 'editor', 'viewer')
    for share;
  if not found then
    raise exception 'Ranking access denied' using errcode = '42501';
  end if;
  if pg_catalog.clock_timestamp() >= timestamptz '2027-06-24 00:00:00+09' then
    return pg_catalog.jsonb_build_object('allowed', false, 'reason', 'expired');
  end if;

  -- Every call takes the fixed project lock before its own user lock. Concurrent
  -- users cannot exceed the project-wide limits or reset another user's budget.
  select * into strict project_budget from public.record_ranking_project_budget
    where singleton = true for update;
  -- Read the time after waiting for the global lock. A queued request must not
  -- reset a newer day/minute back to its stale transaction-start period.
  instant := pg_catalog.clock_timestamp();
  today := (instant at time zone 'Asia/Tokyo')::date;
  minute := pg_catalog.date_trunc('minute', instant);
  if instant >= timestamptz '2027-06-24 00:00:00+09' then
    return pg_catalog.jsonb_build_object('allowed', false, 'reason', 'expired');
  end if;
  project_daily := case when project_budget.usage_day = today then project_budget.daily_count else 0 end;
  if project_budget.lifetime_count >= 5000 then
    return pg_catalog.jsonb_build_object('allowed', false, 'reason', 'project_lifetime');
  end if;
  if project_daily >= 100 then
    return pg_catalog.jsonb_build_object('allowed', false, 'reason', 'project_day');
  end if;

  insert into public.record_ranking_user_budget (user_id, usage_day, usage_minute)
    values (caller, today, minute) on conflict (user_id) do nothing;
  select * into strict user_budget from public.record_ranking_user_budget
    where user_id = caller for update;
  user_daily := case when user_budget.usage_day = today then user_budget.daily_count else 0 end;
  user_minute := case when user_budget.usage_minute = minute then user_budget.minute_count else 0 end;
  if user_daily >= 20 then
    return pg_catalog.jsonb_build_object('allowed', false, 'reason', 'user_day');
  end if;
  if user_minute >= 5 then
    return pg_catalog.jsonb_build_object('allowed', false, 'reason', 'user_minute');
  end if;

  update public.record_ranking_project_budget
    set usage_day = today, daily_count = project_daily + 1,
        lifetime_count = project_budget.lifetime_count + 1
    where singleton = true;
  update public.record_ranking_user_budget
    set usage_day = today, daily_count = user_daily + 1,
        usage_minute = minute, minute_count = user_minute + 1
    where user_id = caller;
  -- Reservation is consumed even if the subsequent API fails. There is no refund RPC.
  return pg_catalog.jsonb_build_object('allowed', true, 'reason', 'reserved');
end;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: schedule_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schedule_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    household_id uuid NOT NULL,
    weekday smallint NOT NULL,
    since date NOT NULL,
    kind text,
    start_time time without time zone,
    end_time time without time zone,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT schedule_rules_check CHECK (((kind IS NOT NULL) OR ((start_time IS NULL) AND (end_time IS NULL)))),
    CONSTRAINT schedule_rules_check1 CHECK (((start_time IS NULL) = (end_time IS NULL))),
    CONSTRAINT schedule_rules_check2 CHECK (((start_time IS NULL) OR (end_time > start_time))),
    CONSTRAINT schedule_rules_kind_check CHECK ((kind = ANY (ARRAY['daycare'::text, 'home'::text, 'clinic'::text, 'salon'::text, 'other'::text]))),
    CONSTRAINT schedule_rules_weekday_check CHECK (((weekday >= 0) AND (weekday <= 6)))
);


--
-- Name: TABLE schedule_rules; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.schedule_rules IS '毎週の予定ルール。(weekday, since) の版で積み、その日に効くのは since がその日以前で最新の版（D34）';


--
-- Name: COLUMN schedule_rules.since; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.schedule_rules.since IS 'この日から効く。過去の日は前の版のまま（作り直しても過去を書き換えない）';


--
-- Name: COLUMN schedule_rules.kind; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.schedule_rules.kind IS 'null は「この日以降はルールなし」を表す墓標';


--
-- Name: schedule_rules_for_range(uuid, date, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.schedule_rules_for_range(p_household uuid, p_from date, p_to date) RETURNS SETOF public.schedule_rules
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select * from (
    select distinct on (r.weekday) r.*
      from public.schedule_rules r
     where r.household_id = p_household
       and r.since <= p_from
     order by r.weekday, r.since desc
  ) active
  union all
  select r.*
    from public.schedule_rules r
   where r.household_id = p_household
     and r.since > p_from
     and r.since <= p_to
$$;


--
-- Name: FUNCTION schedule_rules_for_range(p_household uuid, p_from date, p_to date); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.schedule_rules_for_range(p_household uuid, p_from date, p_to date) IS 'その期間のカレンダーを描くのに要るルールの版だけを返す（版が増えても打ち切られない）';


--
-- Name: set_media_storage_mode(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_media_storage_mode(p_mode text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if not public.media_is_operator() then
    raise exception 'Operator access required' using errcode = '42501';
  end if;
  if p_mode is null or p_mode not in ('frozen','gcs') then
    raise exception 'Invalid media mode' using errcode = '22023';
  end if;
  lock table public.record_photos, public.profiles, public.households,
    public.pets, public.daycare_records, public.media_assets in share row exclusive mode;
  update public.media_storage_state set mode = p_mode, read_backend = 'gcs' where singleton;
  if not found then raise exception 'Media state missing' using errcode = '55000'; end if;
end;
$$;


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


--
-- Name: try_cast_uuid(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.try_cast_uuid(value text) RETURNS uuid
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO ''
    AS $$
begin
  return value::uuid;
exception
  when invalid_text_representation then
    return null;
end;
$$;


--
-- Name: FUNCTION try_cast_uuid(value text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.try_cast_uuid(value text) IS 'text を uuid へ安全にキャストする（不正な形式は null）。Storage パス先頭セグメントの検証など、エラーで式全体を落とせない RLS ポリシー内で使う。';


--
-- Name: daycare_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daycare_records (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_id uuid NOT NULL,
    record_date date DEFAULT CURRENT_DATE NOT NULL,
    body text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    source text DEFAULT 'daycare'::text NOT NULL,
    author text DEFAULT ''::text NOT NULL,
    weight_kg numeric(5,2),
    pet_id uuid,
    household_id uuid NOT NULL,
    guest_visible boolean DEFAULT false NOT NULL,
    status text DEFAULT 'done'::text NOT NULL,
    start_time time without time zone,
    end_time time without time zone,
    overrides_rule boolean DEFAULT false NOT NULL,
    CONSTRAINT daycare_records_source_check CHECK ((source = ANY (ARRAY['daycare'::text, 'home'::text, 'clinic'::text, 'salon'::text, 'other'::text]))),
    CONSTRAINT daycare_records_status_check CHECK ((status = ANY (ARRAY['planned'::text, 'done'::text, 'skipped'::text]))),
    CONSTRAINT daycare_records_time_order_check CHECK (((start_time IS NULL) OR (end_time > start_time))),
    CONSTRAINT daycare_records_time_pair_check CHECK (((start_time IS NULL) = (end_time IS NULL))),
    CONSTRAINT daycare_records_weight_check CHECK (((weight_kg IS NULL) OR (weight_kg > (0)::numeric)))
);


--
-- Name: TABLE daycare_records; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.daycare_records IS '保育園からの日次記録';


--
-- Name: COLUMN daycare_records.record_date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.daycare_records.record_date IS '記録の対象日';


--
-- Name: COLUMN daycare_records.body; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.daycare_records.body IS '保育園からのテキスト本文';


--
-- Name: COLUMN daycare_records.source; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.daycare_records.source IS '種類: daycare=保育園 / home=おうち / clinic=病院 / salon=サロン / other=その他';


--
-- Name: COLUMN daycare_records.author; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.daycare_records.author IS '記入者（保育園スタッフ名 / おうちの記入者）';


--
-- Name: COLUMN daycare_records.weight_kg; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.daycare_records.weight_kg IS 'その日の体重(kg)。未記入は NULL';


--
-- Name: COLUMN daycare_records.pet_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.daycare_records.pet_id IS '記録の対象ペット。未設定は NULL（段階導入）';


--
-- Name: COLUMN daycare_records.household_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.daycare_records.household_id IS '所属世帯（NOT NULL・S1 手順6で確定）';


--
-- Name: COLUMN daycare_records.guest_visible; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.daycare_records.guest_visible IS '対象ペットのゲストに見せるか（D8: 既定 false = ゲストには見えない。ゲスト自身の記入は常に本人可視）';


--
-- Name: COLUMN daycare_records.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.daycare_records.status IS 'planned=予定 / done=記録ずみ / skipped=見送り。完了すると予定が記録になる（D34）';


--
-- Name: COLUMN daycare_records.start_time; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.daycare_records.start_time IS '開始時刻（JST の壁時計）。null は時刻なし（クイック記録など）。end_time と対で持つ';


--
-- Name: COLUMN daycare_records.overrides_rule; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.daycare_records.overrides_rule IS 'true ならその日の曜日ルールを隠す。予定として保存したときだけ true。クイック記録は false（記録を足しただけでルールの予定を消さないため）';


--
-- Name: feedback; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.feedback (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_id uuid NOT NULL,
    kind text DEFAULT 'bug'::text NOT NULL,
    severity text,
    frequency text,
    title text,
    body text DEFAULT ''::text NOT NULL,
    when_happened text,
    expected text,
    actual text,
    reporter text,
    context jsonb,
    github_issue_url text,
    github_issue_number integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    status_changed_at timestamp with time zone DEFAULT now() NOT NULL,
    household_id uuid NOT NULL,
    CONSTRAINT feedback_status_check CHECK ((status = ANY (ARRAY['open'::text, 'triaged'::text, 'closed'::text])))
);


--
-- Name: TABLE feedback; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.feedback IS 'アプリ内フォームから送信された障害報告・機能要望';


--
-- Name: COLUMN feedback.kind; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.feedback.kind IS '種類: bug / request / question';


--
-- Name: COLUMN feedback.context; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.feedback.context IS '送信時に自動収集したアプリの状況 (画面パス・端末情報など)';


--
-- Name: COLUMN feedback.github_issue_url; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.feedback.github_issue_url IS '自動転記した GitHub Issue の URL (転記に失敗した場合は null)';


--
-- Name: COLUMN feedback.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.feedback.status IS 'トリアージ状態: open / triaged / closed';


--
-- Name: COLUMN feedback.status_changed_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.feedback.status_changed_at IS 'status を最後に変更した時刻 (open のままなら作成時刻に同じ)';


--
-- Name: COLUMN feedback.household_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.feedback.household_id IS '所属世帯（NOT NULL・S1 手順6で確定）';


--
-- Name: google_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.google_credentials (
    owner_id uuid NOT NULL,
    refresh_token_enc text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE google_credentials; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.google_credentials IS 'Google Drive 連携用 OAuth refresh token (アプリ層で暗号化して保存)';


--
-- Name: COLUMN google_credentials.refresh_token_enc; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.google_credentials.refresh_token_enc IS 'AES-256-GCM 暗号化済み refresh token。復号鍵は TOKEN_ENC_KEY (サーバー専用)';


--
-- Name: guest_grants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.guest_grants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    household_id uuid NOT NULL,
    user_id uuid NOT NULL,
    scope_pet_id uuid NOT NULL,
    role text NOT NULL,
    valid_from date DEFAULT CURRENT_DATE NOT NULL,
    valid_to date,
    revoked_at timestamp with time zone,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT guest_grants_check CHECK (((valid_to IS NULL) OR (valid_to >= valid_from))),
    CONSTRAINT guest_grants_role_check CHECK ((role = ANY (ARRAY['guest:daycare'::text, 'guest:sitter'::text])))
);


--
-- Name: TABLE guest_grants; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.guest_grants IS '外部ゲスト（保育園/シッター）への対象ペット・期間限定アクセス付与（UC-G01）。内部 role とは別系統';


--
-- Name: COLUMN guest_grants.scope_pet_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.guest_grants.scope_pet_id IS '担当ペット。ペット削除で付与も消える（CASCADE = UC-H11 の決定）';


--
-- Name: COLUMN guest_grants.valid_to; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.guest_grants.valid_to IS '有効期限（この日まで有効・null は取り消しまで）。期間判定は日付単位';


--
-- Name: household_invites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.household_invites (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    household_id uuid NOT NULL,
    email text NOT NULL,
    role text DEFAULT 'editor'::text NOT NULL,
    token text NOT NULL,
    invited_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    accepted_at timestamp with time zone,
    accepted_by uuid,
    revoked_at timestamp with time zone,
    scope_pet_id uuid,
    valid_from date,
    valid_to date,
    CONSTRAINT household_invites_email_not_blank CHECK (((char_length(btrim(email)) >= 3) AND (char_length(btrim(email)) <= 255))),
    CONSTRAINT household_invites_guest_scope CHECK (((role !~~ 'guest:%'::text) OR (scope_pet_id IS NOT NULL))),
    CONSTRAINT household_invites_role_check CHECK ((role = ANY (ARRAY['editor'::text, 'viewer'::text, 'guest:daycare'::text, 'guest:sitter'::text]))),
    CONSTRAINT household_invites_valid_range CHECK (((valid_from IS NULL) OR (valid_to IS NULL) OR (valid_to >= valid_from)))
);


--
-- Name: TABLE household_invites; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.household_invites IS '世帯への招待（宛先メール固定 D12。受諾でのみ household_members へ追加される）';


--
-- Name: COLUMN household_invites.token; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.household_invites.token IS '推測不能なランダムトークン（招待リンクに載る。受諾時はメール一致も要求 D13）';


--
-- Name: COLUMN household_invites.scope_pet_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.household_invites.scope_pet_id IS 'ゲスト招待の対象ペット（guest:* のとき必須）。ペット削除で招待ごと消える（UC-H11 と整合）';


--
-- Name: COLUMN household_invites.valid_from; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.household_invites.valid_from IS 'ゲスト付与の開始日（null は受諾日から）';


--
-- Name: COLUMN household_invites.valid_to; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.household_invites.valid_to IS 'ゲスト付与の終了日（null は取り消しまで）';


--
-- Name: household_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.household_members (
    household_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text DEFAULT 'owner'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT household_members_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'editor'::text, 'viewer'::text])))
);


--
-- Name: TABLE household_members; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.household_members IS '世帯メンバーシップ（household ↔ auth.users の多対多）';


--
-- Name: COLUMN household_members.role; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.household_members.role IS 'メンバー種別: owner（全権・メンバー管理）/ editor（記録・写真・ペット等の編集）/ viewer（閲覧のみ）';


--
-- Name: households; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.households (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    avatar_path text,
    avatar_asset_id uuid
);


--
-- Name: TABLE households; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.households IS 'テナント（世帯）の単位。メンバーは household_members で管理する';


--
-- Name: COLUMN households.name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.households.name IS '世帯名（任意・既定は空文字。アプリから後で命名可能）';


--
-- Name: COLUMN households.avatar_path; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.households.avatar_path IS 'avatars バケット内の世帯アバター画像パス（任意・null=未設定）。';


--
-- Name: media_assets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_assets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    entity_id uuid NOT NULL,
    household_id uuid,
    owner_id uuid,
    created_by uuid,
    incoming_key text NOT NULL,
    final_key text NOT NULL,
    byte_size bigint NOT NULL,
    content_type text NOT NULL,
    state text DEFAULT 'reserved'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    generation text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    is_legacy boolean DEFAULT false NOT NULL,
    legacy_sha256 text,
    legacy_path text,
    legacy_reference_id uuid,
    CONSTRAINT media_assets_byte_size_check CHECK (((byte_size > 0) AND (byte_size <= 10485760))),
    CONSTRAINT media_assets_check CHECK (((is_legacy AND (created_by IS NULL) AND (legacy_sha256 ~ '^[0-9a-f]{64}$'::text) AND (legacy_sha256 IS NOT NULL) AND (legacy_path IS NOT NULL) AND (legacy_path <> ''::text) AND (length(legacy_path) <= 1024) AND (legacy_reference_id IS NOT NULL)) OR ((NOT is_legacy) AND (created_by IS NOT NULL) AND (legacy_sha256 IS NULL) AND (legacy_path IS NULL) AND (legacy_reference_id IS NULL)))),
    CONSTRAINT media_assets_check1 CHECK ((((kind = 'profile'::text) AND (household_id IS NULL) AND (owner_id IS NOT NULL) AND (owner_id = entity_id)) OR ((kind = 'household'::text) AND (household_id IS NOT NULL) AND (household_id = entity_id) AND (owner_id IS NULL)) OR ((kind = ANY (ARRAY['photo'::text, 'pet'::text])) AND (household_id IS NOT NULL) AND (owner_id IS NOT NULL)))),
    CONSTRAINT media_assets_check2 CHECK (((kind = 'photo'::text) OR (byte_size <= 2097152))),
    CONSTRAINT media_assets_check3 CHECK (((state = 'deleted'::text) = (deleted_at IS NOT NULL))),
    CONSTRAINT media_assets_check4 CHECK (((state <> 'ready'::text) OR (generation IS NOT NULL))),
    CONSTRAINT media_assets_check5 CHECK ((incoming_key = ('_incoming/'::text || (id)::text))),
    CONSTRAINT media_assets_check6 CHECK ((is_legacy OR (final_key = (((((COALESCE(household_id, owner_id))::text || '/'::text) ||
CASE
    WHEN (kind = 'photo'::text) THEN (entity_id)::text
    ELSE 'avatars'::text
END) || '/'::text) || (id)::text)))),
    CONSTRAINT media_assets_content_type_check CHECK ((content_type = ANY (ARRAY['image/jpeg'::text, 'image/png'::text, 'image/gif'::text, 'image/webp'::text, 'image/avif'::text]))),
    CONSTRAINT media_assets_final_key_check CHECK (((length(final_key) <= 1024) AND (final_key ~ '^[0-9a-fA-F-]{36}/([0-9a-fA-F-]{36}|avatars)/[a-zA-Z0-9._-]+$'::text) AND (split_part(final_key, '/'::text, 3) <> ALL (ARRAY['.'::text, '..'::text])))),
    CONSTRAINT media_assets_generation_check CHECK ((generation ~ '^[1-9][0-9]{0,19}$'::text)),
    CONSTRAINT media_assets_kind_check CHECK ((kind = ANY (ARRAY['photo'::text, 'profile'::text, 'household'::text, 'pet'::text]))),
    CONSTRAINT media_assets_legacy_reference_scope CHECK (((NOT is_legacy) OR (kind = 'photo'::text) OR (legacy_reference_id = entity_id))),
    CONSTRAINT media_assets_state_check CHECK ((state = ANY (ARRAY['reserved'::text, 'ready'::text, 'deleted'::text])))
);


--
-- Name: media_storage_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_storage_state (
    singleton boolean DEFAULT true NOT NULL,
    mode text DEFAULT 'frozen'::text NOT NULL,
    read_backend text DEFAULT 'gcs'::text NOT NULL,
    CONSTRAINT media_storage_state_mode_check CHECK ((mode = ANY (ARRAY['frozen'::text, 'gcs'::text]))),
    CONSTRAINT media_storage_state_read_backend_check CHECK ((read_backend = ANY (ARRAY['gcs'::text]))),
    CONSTRAINT media_storage_state_singleton_check CHECK (singleton)
);


--
-- Name: pets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_id uuid DEFAULT auth.uid() NOT NULL,
    name text DEFAULT 'うちの子'::text NOT NULL,
    species text,
    birthday date,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    household_id uuid NOT NULL,
    avatar_path text,
    avatar_asset_id uuid
);


--
-- Name: TABLE pets; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.pets IS '飼っているペット (owner_id = auth.uid())';


--
-- Name: COLUMN pets.name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.pets.name IS 'ペットの名前';


--
-- Name: COLUMN pets.species; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.pets.species IS '種類（犬 / 猫 など・任意）';


--
-- Name: COLUMN pets.birthday; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.pets.birthday IS '誕生日（任意）';


--
-- Name: COLUMN pets.household_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.pets.household_id IS '所属世帯（NOT NULL・S1 手順6で確定）';


--
-- Name: COLUMN pets.avatar_path; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.pets.avatar_path IS 'avatars バケット内のアバター画像パス（任意・null=未設定）。世帯で共有。';


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profiles (
    owner_id uuid DEFAULT auth.uid() NOT NULL,
    display_name text,
    default_author text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    avatar_path text,
    avatar_asset_id uuid
);


--
-- Name: TABLE profiles; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.profiles IS 'ユーザーごとのプロフィール / アカウント設定 (owner_id = auth.uid())';


--
-- Name: COLUMN profiles.display_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.profiles.display_name IS '画面に表示する名前（任意）';


--
-- Name: COLUMN profiles.default_author; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.profiles.default_author IS '記録フォームの「記入者」の既定値（任意）';


--
-- Name: COLUMN profiles.avatar_path; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.profiles.avatar_path IS 'avatars バケット内のユーザーアバター画像パス（任意・null=未設定）。個人スコープ。';


--
-- Name: record_assignees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.record_assignees (
    record_id uuid NOT NULL,
    role text NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT record_assignees_role_check CHECK ((role = ANY (ARRAY['drop'::text, 'pick'::text, 'care'::text])))
);


--
-- Name: TABLE record_assignees; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.record_assignees IS '予定・記録の担当（drop=送り / pick=お迎え / care=みる人）。1 つの役割につき 1 人';


--
-- Name: record_photos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.record_photos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    record_id uuid NOT NULL,
    storage_path text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    household_id uuid NOT NULL,
    media_asset_id uuid
);


--
-- Name: TABLE record_photos; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.record_photos IS '記録に紐づく写真メタデータ';


--
-- Name: COLUMN record_photos.storage_path; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.record_photos.storage_path IS 'daycare-photos バケット内のオブジェクトパス';


--
-- Name: COLUMN record_photos.household_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.record_photos.household_id IS '所属世帯（NOT NULL・親 daycare_records から継承）';


--
-- Name: record_ranking_project_budget; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.record_ranking_project_budget (
    singleton boolean DEFAULT true NOT NULL,
    usage_day date NOT NULL,
    daily_count integer DEFAULT 0 NOT NULL,
    lifetime_count integer DEFAULT 0 NOT NULL,
    CONSTRAINT record_ranking_project_budget_daily_count_check CHECK (((daily_count >= 0) AND (daily_count <= 100))),
    CONSTRAINT record_ranking_project_budget_lifetime_count_check CHECK (((lifetime_count >= 0) AND (lifetime_count <= 5000))),
    CONSTRAINT record_ranking_project_budget_singleton_check CHECK (singleton)
);

ALTER TABLE ONLY public.record_ranking_project_budget FORCE ROW LEVEL SECURITY;


--
-- Name: record_ranking_user_budget; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.record_ranking_user_budget (
    user_id uuid NOT NULL,
    usage_day date NOT NULL,
    daily_count integer DEFAULT 0 NOT NULL,
    usage_minute timestamp with time zone NOT NULL,
    minute_count integer DEFAULT 0 NOT NULL,
    CONSTRAINT record_ranking_user_budget_daily_count_check CHECK (((daily_count >= 0) AND (daily_count <= 20))),
    CONSTRAINT record_ranking_user_budget_minute_count_check CHECK (((minute_count >= 0) AND (minute_count <= 5)))
);

ALTER TABLE ONLY public.record_ranking_user_budget FORCE ROW LEVEL SECURITY;


--
-- Name: record_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.record_tags (
    record_id uuid NOT NULL,
    tag_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE record_tags; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.record_tags IS '記録に付与されたタグ（多対多の中間テーブル）';


--
-- Name: schedule_rule_assignees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schedule_rule_assignees (
    rule_id uuid NOT NULL,
    role text NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT schedule_rule_assignees_role_check CHECK ((role = ANY (ARRAY['drop'::text, 'pick'::text, 'care'::text])))
);


--
-- Name: TABLE schedule_rule_assignees; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.schedule_rule_assignees IS '毎週の予定ルールの担当（役割ごとに 1 人）';


--
-- Name: schedule_rule_skips; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schedule_rule_skips (
    household_id uuid NOT NULL,
    on_date date NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE schedule_rule_skips; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.schedule_rule_skips IS 'その日だけ曜日ルールを効かせない（打ち消し）。行を消すとルールに戻る';


--
-- Name: tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tags (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_id uuid NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    household_id uuid,
    CONSTRAINT tags_name_not_blank CHECK (((char_length(btrim(name)) >= 1) AND (char_length(btrim(name)) <= 50)))
);


--
-- Name: TABLE tags; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.tags IS '記録に付与する自由タグ（オーナーごとの辞書）';


--
-- Name: COLUMN tags.name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tags.name IS 'タグ名（オーナー内で一意。前後空白はアプリ側で除去）';


--
-- Name: COLUMN tags.household_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tags.household_id IS '所属世帯（世帯共有のタグ辞書）。移行期は nullable';


--
-- Name: daycare_records daycare_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daycare_records
    ADD CONSTRAINT daycare_records_pkey PRIMARY KEY (id);


--
-- Name: feedback feedback_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feedback
    ADD CONSTRAINT feedback_pkey PRIMARY KEY (id);


--
-- Name: google_credentials google_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.google_credentials
    ADD CONSTRAINT google_credentials_pkey PRIMARY KEY (owner_id);


--
-- Name: guest_grants guest_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guest_grants
    ADD CONSTRAINT guest_grants_pkey PRIMARY KEY (id);


--
-- Name: household_invites household_invites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.household_invites
    ADD CONSTRAINT household_invites_pkey PRIMARY KEY (id);


--
-- Name: household_invites household_invites_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.household_invites
    ADD CONSTRAINT household_invites_token_key UNIQUE (token);


--
-- Name: household_members household_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.household_members
    ADD CONSTRAINT household_members_pkey PRIMARY KEY (household_id, user_id);


--
-- Name: households households_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.households
    ADD CONSTRAINT households_pkey PRIMARY KEY (id);


--
-- Name: media_assets media_assets_final_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_assets
    ADD CONSTRAINT media_assets_final_key_key UNIQUE (final_key);


--
-- Name: media_assets media_assets_incoming_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_assets
    ADD CONSTRAINT media_assets_incoming_key_key UNIQUE (incoming_key);


--
-- Name: media_assets media_assets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_assets
    ADD CONSTRAINT media_assets_pkey PRIMARY KEY (id);


--
-- Name: media_storage_state media_storage_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_storage_state
    ADD CONSTRAINT media_storage_state_pkey PRIMARY KEY (singleton);


--
-- Name: pets pets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pets
    ADD CONSTRAINT pets_pkey PRIMARY KEY (id);


--
-- Name: profiles profiles_owner_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_owner_id_key UNIQUE (owner_id);


--
-- Name: record_assignees record_assignees_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.record_assignees
    ADD CONSTRAINT record_assignees_pkey PRIMARY KEY (record_id, role);


--
-- Name: record_photos record_photos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.record_photos
    ADD CONSTRAINT record_photos_pkey PRIMARY KEY (id);


--
-- Name: record_ranking_project_budget record_ranking_project_budget_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.record_ranking_project_budget
    ADD CONSTRAINT record_ranking_project_budget_pkey PRIMARY KEY (singleton);


--
-- Name: record_ranking_user_budget record_ranking_user_budget_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.record_ranking_user_budget
    ADD CONSTRAINT record_ranking_user_budget_pkey PRIMARY KEY (user_id);


--
-- Name: record_tags record_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.record_tags
    ADD CONSTRAINT record_tags_pkey PRIMARY KEY (record_id, tag_id);


--
-- Name: schedule_rule_assignees schedule_rule_assignees_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_rule_assignees
    ADD CONSTRAINT schedule_rule_assignees_pkey PRIMARY KEY (rule_id, role);


--
-- Name: schedule_rule_skips schedule_rule_skips_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_rule_skips
    ADD CONSTRAINT schedule_rule_skips_pkey PRIMARY KEY (household_id, on_date);


--
-- Name: schedule_rules schedule_rules_household_id_weekday_since_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_rules
    ADD CONSTRAINT schedule_rules_household_id_weekday_since_key UNIQUE (household_id, weekday, since);


--
-- Name: schedule_rules schedule_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_rules
    ADD CONSTRAINT schedule_rules_pkey PRIMARY KEY (id);


--
-- Name: tags tags_owner_name_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_owner_name_unique UNIQUE (owner_id, name);


--
-- Name: tags tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_pkey PRIMARY KEY (id);


--
-- Name: daycare_records_author_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX daycare_records_author_trgm_idx ON public.daycare_records USING gin (author extensions.gin_trgm_ops);


--
-- Name: daycare_records_body_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX daycare_records_body_trgm_idx ON public.daycare_records USING gin (body extensions.gin_trgm_ops);


--
-- Name: daycare_records_household_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX daycare_records_household_date_idx ON public.daycare_records USING btree (household_id, record_date DESC);


--
-- Name: daycare_records_household_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX daycare_records_household_idx ON public.daycare_records USING btree (household_id);


--
-- Name: daycare_records_household_status_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX daycare_records_household_status_date_idx ON public.daycare_records USING btree (household_id, status, record_date DESC);


--
-- Name: daycare_records_owner_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX daycare_records_owner_date_idx ON public.daycare_records USING btree (owner_id, record_date DESC);


--
-- Name: daycare_records_owner_pet_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX daycare_records_owner_pet_date_idx ON public.daycare_records USING btree (owner_id, pet_id, record_date DESC);


--
-- Name: daycare_records_owner_source_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX daycare_records_owner_source_date_idx ON public.daycare_records USING btree (owner_id, source, record_date DESC);


--
-- Name: daycare_records_owner_weight_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX daycare_records_owner_weight_idx ON public.daycare_records USING btree (owner_id, weight_kg);


--
-- Name: feedback_household_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX feedback_household_idx ON public.feedback USING btree (household_id);


--
-- Name: feedback_owner_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX feedback_owner_created_idx ON public.feedback USING btree (owner_id, created_at DESC);


--
-- Name: feedback_owner_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX feedback_owner_status_idx ON public.feedback USING btree (owner_id, status, created_at DESC);


--
-- Name: guest_grants_household_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX guest_grants_household_idx ON public.guest_grants USING btree (household_id);


--
-- Name: guest_grants_pet_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX guest_grants_pet_idx ON public.guest_grants USING btree (scope_pet_id);


--
-- Name: guest_grants_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX guest_grants_user_idx ON public.guest_grants USING btree (user_id);


--
-- Name: household_invites_email_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX household_invites_email_idx ON public.household_invites USING btree (lower(email));


--
-- Name: household_invites_household_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX household_invites_household_idx ON public.household_invites USING btree (household_id, created_at DESC);


--
-- Name: household_members_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX household_members_user_idx ON public.household_members USING btree (user_id);


--
-- Name: households_avatar_asset_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX households_avatar_asset_idx ON public.households USING btree (avatar_asset_id);


--
-- Name: media_assets_creator_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_assets_creator_created_idx ON public.media_assets USING btree (created_by, created_at);


--
-- Name: media_assets_household_state_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_assets_household_state_idx ON public.media_assets USING btree (household_id, state);


--
-- Name: media_assets_target_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_assets_target_idx ON public.media_assets USING btree (kind, entity_id);


--
-- Name: pets_avatar_asset_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pets_avatar_asset_idx ON public.pets USING btree (avatar_asset_id);


--
-- Name: pets_household_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pets_household_idx ON public.pets USING btree (household_id);


--
-- Name: pets_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pets_owner_idx ON public.pets USING btree (owner_id, created_at);


--
-- Name: profiles_avatar_asset_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX profiles_avatar_asset_idx ON public.profiles USING btree (avatar_asset_id);


--
-- Name: record_assignees_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX record_assignees_user_idx ON public.record_assignees USING btree (user_id);


--
-- Name: record_photos_asset_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX record_photos_asset_idx ON public.record_photos USING btree (media_asset_id);


--
-- Name: record_photos_household_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX record_photos_household_idx ON public.record_photos USING btree (household_id);


--
-- Name: record_photos_record_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX record_photos_record_idx ON public.record_photos USING btree (record_id);


--
-- Name: record_tags_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX record_tags_owner_idx ON public.record_tags USING btree (owner_id);


--
-- Name: record_tags_tag_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX record_tags_tag_idx ON public.record_tags USING btree (tag_id);


--
-- Name: schedule_rule_assignees_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX schedule_rule_assignees_user_idx ON public.schedule_rule_assignees USING btree (user_id);


--
-- Name: schedule_rules_household_weekday_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX schedule_rules_household_weekday_idx ON public.schedule_rules USING btree (household_id, weekday, since DESC);


--
-- Name: tags_household_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tags_household_idx ON public.tags USING btree (household_id);


--
-- Name: tags_household_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tags_household_name_idx ON public.tags USING btree (household_id, name);


--
-- Name: tags_owner_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tags_owner_name_idx ON public.tags USING btree (owner_id, name);


--
-- Name: daycare_records daycare_records_forbid_owner_change; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER daycare_records_forbid_owner_change BEFORE UPDATE ON public.daycare_records FOR EACH ROW EXECUTE FUNCTION public.forbid_owner_change();


--
-- Name: daycare_records daycare_records_media_deleted; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER daycare_records_media_deleted AFTER DELETE ON public.daycare_records FOR EACH ROW EXECUTE FUNCTION public.media_parent_deleted();


--
-- Name: daycare_records daycare_records_media_parent_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER daycare_records_media_parent_guard BEFORE DELETE OR UPDATE ON public.daycare_records FOR EACH ROW EXECUTE FUNCTION public.media_parent_guard();


--
-- Name: daycare_records daycare_records_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER daycare_records_set_updated_at BEFORE UPDATE ON public.daycare_records FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: feedback feedback_forbid_owner_change; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER feedback_forbid_owner_change BEFORE UPDATE ON public.feedback FOR EACH ROW EXECUTE FUNCTION public.forbid_owner_change();


--
-- Name: household_members household_members_enforce_last_owner; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER household_members_enforce_last_owner BEFORE DELETE OR UPDATE ON public.household_members FOR EACH ROW EXECUTE FUNCTION public.enforce_last_owner();


--
-- Name: household_members household_members_prune_schedule; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER household_members_prune_schedule AFTER DELETE ON public.household_members FOR EACH ROW EXECUTE FUNCTION public.prune_schedule_assignments();


--
-- Name: households households_media_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER households_media_guard BEFORE INSERT OR DELETE OR UPDATE ON public.households FOR EACH ROW EXECUTE FUNCTION public.media_reference_guard();


--
-- Name: households households_media_parent_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER households_media_parent_guard BEFORE DELETE ON public.households FOR EACH ROW EXECUTE FUNCTION public.media_parent_guard();


--
-- Name: households households_media_retired; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER households_media_retired AFTER DELETE OR UPDATE ON public.households FOR EACH ROW EXECUTE FUNCTION public.media_reference_retired();


--
-- Name: media_assets media_assets_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER media_assets_immutable BEFORE INSERT OR DELETE OR UPDATE ON public.media_assets FOR EACH ROW EXECUTE FUNCTION public.media_assets_guard();


--
-- Name: pets pets_forbid_owner_change; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER pets_forbid_owner_change BEFORE UPDATE ON public.pets FOR EACH ROW EXECUTE FUNCTION public.forbid_owner_change();


--
-- Name: pets pets_media_deleted; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER pets_media_deleted AFTER DELETE ON public.pets FOR EACH ROW EXECUTE FUNCTION public.media_parent_deleted();


--
-- Name: pets pets_media_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER pets_media_guard BEFORE INSERT OR DELETE OR UPDATE ON public.pets FOR EACH ROW EXECUTE FUNCTION public.media_reference_guard();


--
-- Name: pets pets_media_parent_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER pets_media_parent_guard BEFORE UPDATE ON public.pets FOR EACH ROW EXECUTE FUNCTION public.media_parent_guard();


--
-- Name: pets pets_media_retired; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER pets_media_retired AFTER DELETE OR UPDATE ON public.pets FOR EACH ROW EXECUTE FUNCTION public.media_reference_retired();


--
-- Name: pets pets_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER pets_set_updated_at BEFORE UPDATE ON public.pets FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: profiles profiles_media_deleted; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER profiles_media_deleted AFTER DELETE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.media_parent_deleted();


--
-- Name: profiles profiles_media_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER profiles_media_guard BEFORE INSERT OR DELETE OR UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.media_reference_guard();


--
-- Name: profiles profiles_media_retired; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER profiles_media_retired AFTER DELETE OR UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.media_reference_retired();


--
-- Name: profiles profiles_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER profiles_set_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: record_photos record_photos_media_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER record_photos_media_guard BEFORE INSERT OR DELETE OR UPDATE ON public.record_photos FOR EACH ROW EXECUTE FUNCTION public.media_reference_guard();


--
-- Name: record_photos record_photos_media_retired; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER record_photos_media_retired AFTER DELETE OR UPDATE ON public.record_photos FOR EACH ROW EXECUTE FUNCTION public.media_reference_retired();


--
-- Name: schedule_rules schedule_rules_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER schedule_rules_set_updated_at BEFORE UPDATE ON public.schedule_rules FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: tags tags_forbid_owner_change; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tags_forbid_owner_change BEFORE UPDATE ON public.tags FOR EACH ROW EXECUTE FUNCTION public.forbid_owner_change();


--
-- Name: daycare_records daycare_records_household_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daycare_records
    ADD CONSTRAINT daycare_records_household_id_fkey FOREIGN KEY (household_id) REFERENCES public.households(id);


--
-- Name: daycare_records daycare_records_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daycare_records
    ADD CONSTRAINT daycare_records_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: daycare_records daycare_records_pet_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daycare_records
    ADD CONSTRAINT daycare_records_pet_id_fkey FOREIGN KEY (pet_id) REFERENCES public.pets(id) ON DELETE SET NULL;


--
-- Name: feedback feedback_household_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feedback
    ADD CONSTRAINT feedback_household_id_fkey FOREIGN KEY (household_id) REFERENCES public.households(id);


--
-- Name: feedback feedback_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feedback
    ADD CONSTRAINT feedback_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: google_credentials google_credentials_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.google_credentials
    ADD CONSTRAINT google_credentials_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: guest_grants guest_grants_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guest_grants
    ADD CONSTRAINT guest_grants_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: guest_grants guest_grants_household_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guest_grants
    ADD CONSTRAINT guest_grants_household_id_fkey FOREIGN KEY (household_id) REFERENCES public.households(id) ON DELETE CASCADE;


--
-- Name: guest_grants guest_grants_scope_pet_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guest_grants
    ADD CONSTRAINT guest_grants_scope_pet_id_fkey FOREIGN KEY (scope_pet_id) REFERENCES public.pets(id) ON DELETE CASCADE;


--
-- Name: guest_grants guest_grants_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guest_grants
    ADD CONSTRAINT guest_grants_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: household_invites household_invites_accepted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.household_invites
    ADD CONSTRAINT household_invites_accepted_by_fkey FOREIGN KEY (accepted_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: household_invites household_invites_household_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.household_invites
    ADD CONSTRAINT household_invites_household_id_fkey FOREIGN KEY (household_id) REFERENCES public.households(id) ON DELETE CASCADE;


--
-- Name: household_invites household_invites_invited_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.household_invites
    ADD CONSTRAINT household_invites_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: household_invites household_invites_scope_pet_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.household_invites
    ADD CONSTRAINT household_invites_scope_pet_id_fkey FOREIGN KEY (scope_pet_id) REFERENCES public.pets(id) ON DELETE CASCADE;


--
-- Name: household_members household_members_household_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.household_members
    ADD CONSTRAINT household_members_household_id_fkey FOREIGN KEY (household_id) REFERENCES public.households(id) ON DELETE CASCADE;


--
-- Name: household_members household_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.household_members
    ADD CONSTRAINT household_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: households households_avatar_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.households
    ADD CONSTRAINT households_avatar_asset_id_fkey FOREIGN KEY (avatar_asset_id) REFERENCES public.media_assets(id);


--
-- Name: pets pets_avatar_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pets
    ADD CONSTRAINT pets_avatar_asset_id_fkey FOREIGN KEY (avatar_asset_id) REFERENCES public.media_assets(id);


--
-- Name: pets pets_household_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pets
    ADD CONSTRAINT pets_household_id_fkey FOREIGN KEY (household_id) REFERENCES public.households(id);


--
-- Name: pets pets_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pets
    ADD CONSTRAINT pets_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: profiles profiles_avatar_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_avatar_asset_id_fkey FOREIGN KEY (avatar_asset_id) REFERENCES public.media_assets(id);


--
-- Name: profiles profiles_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: record_assignees record_assignees_record_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.record_assignees
    ADD CONSTRAINT record_assignees_record_id_fkey FOREIGN KEY (record_id) REFERENCES public.daycare_records(id) ON DELETE CASCADE;


--
-- Name: record_assignees record_assignees_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.record_assignees
    ADD CONSTRAINT record_assignees_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: record_photos record_photos_household_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.record_photos
    ADD CONSTRAINT record_photos_household_id_fkey FOREIGN KEY (household_id) REFERENCES public.households(id);


--
-- Name: record_photos record_photos_media_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.record_photos
    ADD CONSTRAINT record_photos_media_asset_id_fkey FOREIGN KEY (media_asset_id) REFERENCES public.media_assets(id);


--
-- Name: record_photos record_photos_record_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.record_photos
    ADD CONSTRAINT record_photos_record_id_fkey FOREIGN KEY (record_id) REFERENCES public.daycare_records(id) ON DELETE CASCADE;


--
-- Name: record_ranking_user_budget record_ranking_user_budget_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.record_ranking_user_budget
    ADD CONSTRAINT record_ranking_user_budget_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: record_tags record_tags_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.record_tags
    ADD CONSTRAINT record_tags_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: record_tags record_tags_record_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.record_tags
    ADD CONSTRAINT record_tags_record_id_fkey FOREIGN KEY (record_id) REFERENCES public.daycare_records(id) ON DELETE CASCADE;


--
-- Name: record_tags record_tags_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.record_tags
    ADD CONSTRAINT record_tags_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.tags(id) ON DELETE CASCADE;


--
-- Name: schedule_rule_assignees schedule_rule_assignees_rule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_rule_assignees
    ADD CONSTRAINT schedule_rule_assignees_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES public.schedule_rules(id) ON DELETE CASCADE;


--
-- Name: schedule_rule_assignees schedule_rule_assignees_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_rule_assignees
    ADD CONSTRAINT schedule_rule_assignees_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: schedule_rule_skips schedule_rule_skips_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_rule_skips
    ADD CONSTRAINT schedule_rule_skips_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: schedule_rule_skips schedule_rule_skips_household_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_rule_skips
    ADD CONSTRAINT schedule_rule_skips_household_id_fkey FOREIGN KEY (household_id) REFERENCES public.households(id) ON DELETE CASCADE;


--
-- Name: schedule_rules schedule_rules_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_rules
    ADD CONSTRAINT schedule_rules_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: schedule_rules schedule_rules_household_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_rules
    ADD CONSTRAINT schedule_rules_household_id_fkey FOREIGN KEY (household_id) REFERENCES public.households(id) ON DELETE CASCADE;


--
-- Name: tags tags_household_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_household_id_fkey FOREIGN KEY (household_id) REFERENCES public.households(id);


--
-- Name: tags tags_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: daycare_records; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.daycare_records ENABLE ROW LEVEL SECURITY;

--
-- Name: feedback; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.feedback ENABLE ROW LEVEL SECURITY;

--
-- Name: feedback feedback_delete_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY feedback_delete_member ON public.feedback FOR DELETE USING ((public.has_household_role(household_id, ARRAY['owner'::text, 'editor'::text]) AND public.is_household_member(household_id, owner_id)));


--
-- Name: feedback feedback_delete_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY feedback_delete_own ON public.feedback FOR DELETE USING ((auth.uid() = owner_id));


--
-- Name: feedback feedback_insert_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY feedback_insert_member ON public.feedback FOR INSERT WITH CHECK ((public.has_household_role(household_id, ARRAY['owner'::text, 'editor'::text]) AND public.is_household_member(household_id, owner_id)));


--
-- Name: feedback feedback_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY feedback_insert_own ON public.feedback FOR INSERT WITH CHECK ((auth.uid() = owner_id));


--
-- Name: feedback feedback_select_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY feedback_select_member ON public.feedback FOR SELECT USING ((public.has_household_role(household_id) AND public.is_household_member(household_id, owner_id)));


--
-- Name: feedback feedback_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY feedback_select_own ON public.feedback FOR SELECT USING ((auth.uid() = owner_id));


--
-- Name: feedback feedback_update_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY feedback_update_member ON public.feedback FOR UPDATE USING ((public.has_household_role(household_id, ARRAY['owner'::text, 'editor'::text]) AND public.is_household_member(household_id, owner_id))) WITH CHECK ((public.has_household_role(household_id, ARRAY['owner'::text, 'editor'::text]) AND public.is_household_member(household_id, owner_id)));


--
-- Name: feedback feedback_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY feedback_update_own ON public.feedback FOR UPDATE USING ((auth.uid() = owner_id)) WITH CHECK ((auth.uid() = owner_id));


--
-- Name: google_credentials; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.google_credentials ENABLE ROW LEVEL SECURITY;

--
-- Name: google_credentials google_credentials_delete_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY google_credentials_delete_own ON public.google_credentials FOR DELETE USING ((auth.uid() = owner_id));


--
-- Name: google_credentials google_credentials_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY google_credentials_insert_own ON public.google_credentials FOR INSERT WITH CHECK ((auth.uid() = owner_id));


--
-- Name: google_credentials google_credentials_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY google_credentials_select_own ON public.google_credentials FOR SELECT USING ((auth.uid() = owner_id));


--
-- Name: google_credentials google_credentials_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY google_credentials_update_own ON public.google_credentials FOR UPDATE USING ((auth.uid() = owner_id)) WITH CHECK ((auth.uid() = owner_id));


--
-- Name: guest_grants; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.guest_grants ENABLE ROW LEVEL SECURITY;

--
-- Name: guest_grants guest_grants_delete_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY guest_grants_delete_owner ON public.guest_grants FOR DELETE USING (public.has_household_role(household_id, ARRAY['owner'::text]));


--
-- Name: guest_grants guest_grants_insert_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY guest_grants_insert_owner ON public.guest_grants FOR INSERT WITH CHECK ((public.has_household_role(household_id, ARRAY['owner'::text]) AND (created_by = auth.uid()) AND (EXISTS ( SELECT 1
   FROM public.pets p
  WHERE ((p.id = guest_grants.scope_pet_id) AND (p.household_id = guest_grants.household_id))))));


--
-- Name: guest_grants guest_grants_select_own_or_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY guest_grants_select_own_or_owner ON public.guest_grants FOR SELECT USING (((user_id = auth.uid()) OR public.has_household_role(household_id, ARRAY['owner'::text])));


--
-- Name: guest_grants guest_grants_update_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY guest_grants_update_owner ON public.guest_grants FOR UPDATE USING (public.has_household_role(household_id, ARRAY['owner'::text])) WITH CHECK ((public.has_household_role(household_id, ARRAY['owner'::text]) AND (EXISTS ( SELECT 1
   FROM public.pets p
  WHERE ((p.id = guest_grants.scope_pet_id) AND (p.household_id = guest_grants.household_id))))));


--
-- Name: household_invites; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.household_invites ENABLE ROW LEVEL SECURITY;

--
-- Name: household_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.household_members ENABLE ROW LEVEL SECURITY;

--
-- Name: household_members household_members_delete_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY household_members_delete_owner ON public.household_members FOR DELETE USING (public.has_household_role(household_id, ARRAY['owner'::text]));


--
-- Name: household_members household_members_delete_self; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY household_members_delete_self ON public.household_members FOR DELETE USING ((user_id = auth.uid()));


--
-- Name: household_members household_members_select_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY household_members_select_member ON public.household_members FOR SELECT USING (public.has_household_role(household_id));


--
-- Name: household_members household_members_select_self; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY household_members_select_self ON public.household_members FOR SELECT USING ((user_id = auth.uid()));


--
-- Name: household_members household_members_update_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY household_members_update_owner ON public.household_members FOR UPDATE USING (public.has_household_role(household_id, ARRAY['owner'::text])) WITH CHECK (public.has_household_role(household_id, ARRAY['owner'::text]));


--
-- Name: households; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.households ENABLE ROW LEVEL SECURITY;

--
-- Name: households households_select_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY households_select_member ON public.households FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.household_members m
  WHERE ((m.household_id = households.id) AND (m.user_id = auth.uid())))));


--
-- Name: households households_update_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY households_update_owner ON public.households FOR UPDATE USING (public.has_household_role(id, ARRAY['owner'::text])) WITH CHECK (public.has_household_role(id, ARRAY['owner'::text]));


--
-- Name: household_invites invites_delete_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY invites_delete_owner ON public.household_invites FOR DELETE USING (public.has_household_role(household_id, ARRAY['owner'::text]));


--
-- Name: household_invites invites_insert_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY invites_insert_owner ON public.household_invites FOR INSERT WITH CHECK (((invited_by = auth.uid()) AND public.has_household_role(household_id, ARRAY['owner'::text]) AND ((scope_pet_id IS NULL) OR (EXISTS ( SELECT 1
   FROM public.pets p
  WHERE ((p.id = household_invites.scope_pet_id) AND (p.household_id = household_invites.household_id)))))));


--
-- Name: household_invites invites_select_invitee; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY invites_select_invitee ON public.household_invites FOR SELECT USING ((lower(email) = lower(COALESCE((auth.jwt() ->> 'email'::text), ''::text))));


--
-- Name: household_invites invites_select_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY invites_select_owner ON public.household_invites FOR SELECT USING (public.has_household_role(household_id, ARRAY['owner'::text]));


--
-- Name: household_invites invites_update_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY invites_update_owner ON public.household_invites FOR UPDATE USING (public.has_household_role(household_id, ARRAY['owner'::text])) WITH CHECK (public.has_household_role(household_id, ARRAY['owner'::text]));


--
-- Name: media_assets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.media_assets ENABLE ROW LEVEL SECURITY;

--
-- Name: media_assets media_assets_select_scope; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY media_assets_select_scope ON public.media_assets FOR SELECT TO authenticated USING ((((kind = 'profile'::text) AND (owner_id = auth.uid())) OR ((kind <> 'profile'::text) AND public.has_household_role(household_id))));


--
-- Name: media_storage_state; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.media_storage_state ENABLE ROW LEVEL SECURITY;

--
-- Name: pets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pets ENABLE ROW LEVEL SECURITY;

--
-- Name: pets pets_delete_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pets_delete_member ON public.pets FOR DELETE USING (public.has_household_role(household_id, ARRAY['owner'::text, 'editor'::text]));


--
-- Name: pets pets_insert_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pets_insert_member ON public.pets FOR INSERT WITH CHECK ((public.has_household_role(household_id, ARRAY['owner'::text, 'editor'::text]) AND public.is_household_member(household_id, owner_id)));


--
-- Name: pets pets_select_guest; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pets_select_guest ON public.pets FOR SELECT USING (public.has_guest_access(household_id, id));


--
-- Name: pets pets_select_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pets_select_member ON public.pets FOR SELECT USING (public.has_household_role(household_id));


--
-- Name: pets pets_update_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pets_update_member ON public.pets FOR UPDATE USING (public.has_household_role(household_id, ARRAY['owner'::text, 'editor'::text])) WITH CHECK (public.has_household_role(household_id, ARRAY['owner'::text, 'editor'::text]));


--
-- Name: record_photos photos_delete_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY photos_delete_member ON public.record_photos FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.daycare_records r
  WHERE ((r.id = record_photos.record_id) AND public.has_household_role(r.household_id, ARRAY['owner'::text, 'editor'::text])))));


--
-- Name: record_photos photos_insert_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY photos_insert_member ON public.record_photos FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.daycare_records r
  WHERE ((r.id = record_photos.record_id) AND public.has_household_role(r.household_id, ARRAY['owner'::text, 'editor'::text])))));


--
-- Name: record_photos photos_select_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY photos_select_member ON public.record_photos FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.daycare_records r
  WHERE ((r.id = record_photos.record_id) AND public.has_household_role(r.household_id)))));


--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles profiles_delete_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profiles_delete_own ON public.profiles FOR DELETE USING ((auth.uid() = owner_id));


--
-- Name: profiles profiles_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profiles_insert_own ON public.profiles FOR INSERT WITH CHECK ((auth.uid() = owner_id));


--
-- Name: profiles profiles_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profiles_select_own ON public.profiles FOR SELECT USING ((auth.uid() = owner_id));


--
-- Name: profiles profiles_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profiles_update_own ON public.profiles FOR UPDATE USING ((auth.uid() = owner_id)) WITH CHECK ((auth.uid() = owner_id));


--
-- Name: record_assignees; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.record_assignees ENABLE ROW LEVEL SECURITY;

--
-- Name: record_assignees record_assignees_delete_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY record_assignees_delete_member ON public.record_assignees FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.daycare_records r
  WHERE ((r.id = record_assignees.record_id) AND public.has_household_role(r.household_id, ARRAY['owner'::text, 'editor'::text])))));


--
-- Name: record_assignees record_assignees_insert_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY record_assignees_insert_member ON public.record_assignees FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.daycare_records r
  WHERE ((r.id = record_assignees.record_id) AND public.has_household_role(r.household_id, ARRAY['owner'::text, 'editor'::text]) AND public.is_household_member(r.household_id, record_assignees.user_id)))));


--
-- Name: record_assignees record_assignees_select_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY record_assignees_select_member ON public.record_assignees FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.daycare_records r
  WHERE ((r.id = record_assignees.record_id) AND public.has_household_role(r.household_id)))));


--
-- Name: record_assignees record_assignees_update_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY record_assignees_update_member ON public.record_assignees FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.daycare_records r
  WHERE ((r.id = record_assignees.record_id) AND public.has_household_role(r.household_id, ARRAY['owner'::text, 'editor'::text]))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.daycare_records r
  WHERE ((r.id = record_assignees.record_id) AND public.has_household_role(r.household_id, ARRAY['owner'::text, 'editor'::text]) AND public.is_household_member(r.household_id, record_assignees.user_id)))));


--
-- Name: record_photos; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.record_photos ENABLE ROW LEVEL SECURITY;

--
-- Name: record_ranking_project_budget; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.record_ranking_project_budget ENABLE ROW LEVEL SECURITY;

--
-- Name: record_ranking_user_budget; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.record_ranking_user_budget ENABLE ROW LEVEL SECURITY;

--
-- Name: record_tags; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.record_tags ENABLE ROW LEVEL SECURITY;

--
-- Name: record_tags record_tags_delete_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY record_tags_delete_member ON public.record_tags FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.daycare_records r
  WHERE ((r.id = record_tags.record_id) AND public.has_household_role(r.household_id, ARRAY['owner'::text, 'editor'::text])))));


--
-- Name: record_tags record_tags_insert_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY record_tags_insert_member ON public.record_tags FOR INSERT WITH CHECK (((owner_id = auth.uid()) AND (EXISTS ( SELECT 1
   FROM public.daycare_records r
  WHERE ((r.id = record_tags.record_id) AND public.has_household_role(r.household_id, ARRAY['owner'::text, 'editor'::text])))) AND (EXISTS ( SELECT 1
   FROM (public.tags t
     JOIN public.daycare_records r ON ((r.id = record_tags.record_id)))
  WHERE ((t.id = record_tags.tag_id) AND (t.household_id = r.household_id))))));


--
-- Name: record_tags record_tags_select_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY record_tags_select_member ON public.record_tags FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.daycare_records r
  WHERE ((r.id = record_tags.record_id) AND public.has_household_role(r.household_id)))));


--
-- Name: daycare_records records_delete_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY records_delete_member ON public.daycare_records FOR DELETE USING (public.has_household_role(household_id, ARRAY['owner'::text, 'editor'::text]));


--
-- Name: daycare_records records_insert_guest; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY records_insert_guest ON public.daycare_records FOR INSERT WITH CHECK (((status = 'done'::text) AND (overrides_rule = false) AND (pet_id IS NOT NULL) AND (owner_id = auth.uid()) AND (guest_visible = false) AND public.has_guest_record_access(household_id, pet_id, record_date)));


--
-- Name: daycare_records records_insert_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY records_insert_member ON public.daycare_records FOR INSERT WITH CHECK ((public.has_household_role(household_id, ARRAY['owner'::text, 'editor'::text]) AND public.is_household_member(household_id, owner_id) AND ((pet_id IS NULL) OR (EXISTS ( SELECT 1
   FROM public.pets p
  WHERE ((p.id = daycare_records.pet_id) AND (p.household_id = daycare_records.household_id)))))));


--
-- Name: daycare_records records_select_guest; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY records_select_guest ON public.daycare_records FOR SELECT USING (((status = 'done'::text) AND (pet_id IS NOT NULL) AND ((owner_id = auth.uid()) OR guest_visible) AND public.has_guest_record_access(household_id, pet_id, record_date)));


--
-- Name: daycare_records records_select_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY records_select_member ON public.daycare_records FOR SELECT USING (public.has_household_role(household_id));


--
-- Name: daycare_records records_update_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY records_update_member ON public.daycare_records FOR UPDATE USING (public.has_household_role(household_id, ARRAY['owner'::text, 'editor'::text])) WITH CHECK ((public.has_household_role(household_id, ARRAY['owner'::text, 'editor'::text]) AND ((pet_id IS NULL) OR (EXISTS ( SELECT 1
   FROM public.pets p
  WHERE ((p.id = daycare_records.pet_id) AND (p.household_id = daycare_records.household_id)))))));


--
-- Name: schedule_rule_assignees; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.schedule_rule_assignees ENABLE ROW LEVEL SECURITY;

--
-- Name: schedule_rule_assignees schedule_rule_assignees_delete_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY schedule_rule_assignees_delete_member ON public.schedule_rule_assignees FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.schedule_rules s
  WHERE ((s.id = schedule_rule_assignees.rule_id) AND (s.since >= public.jst_today()) AND public.has_household_role(s.household_id, ARRAY['owner'::text, 'editor'::text])))));


--
-- Name: schedule_rule_assignees schedule_rule_assignees_insert_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY schedule_rule_assignees_insert_member ON public.schedule_rule_assignees FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.schedule_rules s
  WHERE ((s.id = schedule_rule_assignees.rule_id) AND (s.since >= public.jst_today()) AND public.has_household_role(s.household_id, ARRAY['owner'::text, 'editor'::text]) AND public.is_household_member(s.household_id, schedule_rule_assignees.user_id)))));


--
-- Name: schedule_rule_assignees schedule_rule_assignees_select_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY schedule_rule_assignees_select_member ON public.schedule_rule_assignees FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.schedule_rules s
  WHERE ((s.id = schedule_rule_assignees.rule_id) AND public.has_household_role(s.household_id)))));


--
-- Name: schedule_rule_assignees schedule_rule_assignees_update_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY schedule_rule_assignees_update_member ON public.schedule_rule_assignees FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.schedule_rules s
  WHERE ((s.id = schedule_rule_assignees.rule_id) AND (s.since >= public.jst_today()) AND public.has_household_role(s.household_id, ARRAY['owner'::text, 'editor'::text]))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.schedule_rules s
  WHERE ((s.id = schedule_rule_assignees.rule_id) AND (s.since >= public.jst_today()) AND public.has_household_role(s.household_id, ARRAY['owner'::text, 'editor'::text]) AND public.is_household_member(s.household_id, schedule_rule_assignees.user_id)))));


--
-- Name: schedule_rule_skips; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.schedule_rule_skips ENABLE ROW LEVEL SECURITY;

--
-- Name: schedule_rule_skips schedule_rule_skips_delete_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY schedule_rule_skips_delete_member ON public.schedule_rule_skips FOR DELETE USING (public.has_household_role(household_id, ARRAY['owner'::text, 'editor'::text]));


--
-- Name: schedule_rule_skips schedule_rule_skips_insert_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY schedule_rule_skips_insert_member ON public.schedule_rule_skips FOR INSERT WITH CHECK ((public.has_household_role(household_id, ARRAY['owner'::text, 'editor'::text]) AND public.is_household_member(household_id, created_by)));


--
-- Name: schedule_rule_skips schedule_rule_skips_select_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY schedule_rule_skips_select_member ON public.schedule_rule_skips FOR SELECT USING (public.has_household_role(household_id));


--
-- Name: schedule_rules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.schedule_rules ENABLE ROW LEVEL SECURITY;

--
-- Name: schedule_rules schedule_rules_delete_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY schedule_rules_delete_member ON public.schedule_rules FOR DELETE USING ((public.has_household_role(household_id, ARRAY['owner'::text, 'editor'::text]) AND (since >= public.jst_today())));


--
-- Name: schedule_rules schedule_rules_insert_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY schedule_rules_insert_member ON public.schedule_rules FOR INSERT WITH CHECK ((public.has_household_role(household_id, ARRAY['owner'::text, 'editor'::text]) AND public.is_household_member(household_id, created_by) AND (since >= public.jst_today())));


--
-- Name: schedule_rules schedule_rules_select_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY schedule_rules_select_member ON public.schedule_rules FOR SELECT USING (public.has_household_role(household_id));


--
-- Name: tags; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tags ENABLE ROW LEVEL SECURITY;

--
-- Name: tags tags_delete_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tags_delete_member ON public.tags FOR DELETE USING (public.has_household_role(household_id, ARRAY['owner'::text, 'editor'::text]));


--
-- Name: tags tags_insert_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tags_insert_member ON public.tags FOR INSERT WITH CHECK (((owner_id = auth.uid()) AND public.has_household_role(household_id, ARRAY['owner'::text, 'editor'::text]) AND public.is_household_member(household_id, owner_id)));


--
-- Name: tags tags_select_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tags_select_member ON public.tags FOR SELECT USING (public.has_household_role(household_id));


--
-- Name: tags tags_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tags_select_own ON public.tags FOR SELECT USING (((auth.uid() = owner_id) AND (household_id IS NULL)));


--
-- Name: tags tags_update_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tags_update_member ON public.tags FOR UPDATE USING (public.has_household_role(household_id, ARRAY['owner'::text, 'editor'::text])) WITH CHECK (public.has_household_role(household_id, ARRAY['owner'::text, 'editor'::text]));


--
-- Name: tags tags_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tags_update_own ON public.tags FOR UPDATE USING (((auth.uid() = owner_id) AND (household_id IS NULL))) WITH CHECK (((auth.uid() = owner_id) AND ((household_id IS NULL) OR public.has_household_role(household_id, ARRAY['owner'::text, 'editor'::text]))));



-- GCP baseline additions. User claims/ready ledger never attest GCS bytes.
CREATE TRIGGER users_media_deleted AFTER DELETE ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.media_account_deleted();
INSERT INTO public.media_storage_state(singleton,mode,read_backend) VALUES(true,'frozen','gcs');
RESET check_function_bodies;
