-- GCS preparation only: default mode preserves Supabase. User-JWT RPC results
-- (including state/generation) are NOT proof that a server verified an object.
-- GCS readers must additionally verify server-created object metadata and generation.
-- Deleted assets are permanent tombstones; restoring bytes requires a new asset/key.

create table public.media_storage_state (
  singleton boolean primary key default true check (singleton),
  mode text not null default 'supabase' check (mode in ('supabase','frozen','gcs'))
);
insert into public.media_storage_state values (true, 'supabase');
alter table public.media_storage_state enable row level security;
revoke all on public.media_storage_state from public, anon, authenticated;

-- VOLATILE obtains a fresh snapshot after a statement waits behind the freeze
-- table locks; a queued Storage request must not use its pre-freeze mode.
create function public.get_media_storage_mode() returns text
language sql volatile security definer set search_path = '' as $$
  select mode from public.media_storage_state where singleton;
$$;
revoke all on function public.get_media_storage_mode() from public, anon;
grant execute on function public.get_media_storage_mode() to anon, authenticated;

-- Operator sessions have no end-user claims. SECURITY DEFINER alone must never
-- turn an authenticated RPC into an operator bypass.
create function public.media_is_operator() returns boolean
language sql stable security invoker set search_path = '' as $$
  select auth.uid() is null and exists (
    select 1 from pg_catalog.pg_roles where rolname = session_user and (rolsuper or rolbypassrls)
  );
$$;
revoke all on function public.media_is_operator() from public, anon, authenticated;

create table public.media_assets (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('photo','profile','household','pet')),
  entity_id uuid not null,
  -- Original scope/identity survive deletion of a parent or account. No cascade.
  household_id uuid,
  owner_id uuid,
  created_by uuid,
  incoming_key text not null unique,
  final_key text not null unique,
  byte_size bigint not null check (byte_size > 0 and byte_size <= 10485760),
  content_type text not null check (content_type in ('image/jpeg','image/png','image/gif','image/webp','image/avif')),
  state text not null default 'reserved' check (state in ('reserved','ready','deleted')),
  expires_at timestamptz not null,
  generation text check (generation ~ '^[1-9][0-9]{0,19}$'),
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  is_legacy boolean not null default false,
  -- Operator-only import receipt: supports independent hash verification and
  -- inverse reference CAS without inventing an end-user uploader.
  legacy_sha256 text,
  legacy_path text,
  legacy_reference_id uuid,
  check ((is_legacy and created_by is null and legacy_sha256 ~ '^[0-9a-f]{64}$'
      and legacy_sha256 is not null and legacy_path is not null and legacy_path <> ''
      and length(legacy_path) <= 1024 and legacy_reference_id is not null)
    or (not is_legacy and created_by is not null and legacy_sha256 is null
      and legacy_path is null and legacy_reference_id is null)),
  constraint media_assets_legacy_reference_scope check (not is_legacy or kind = 'photo' or legacy_reference_id = entity_id),
  check ((kind = 'profile' and household_id is null and owner_id is not null and owner_id = entity_id)
    or (kind = 'household' and household_id is not null and household_id = entity_id and owner_id is null)
    or (kind in ('photo','pet') and household_id is not null and owner_id is not null)),
  check (kind = 'photo' or byte_size <= 2097152),
  check ((state = 'deleted') = (deleted_at is not null)),
  check (state <> 'ready' or generation is not null),
  check (incoming_key = '_incoming/' || id::text),
  check (length(final_key) <= 1024 and final_key ~ '^[0-9a-fA-F-]{36}/([0-9a-fA-F-]{36}|avatars)/[a-zA-Z0-9._-]+$'
    and split_part(final_key, '/', 3) not in ('.','..')),
  check (is_legacy or final_key = coalesce(household_id, owner_id)::text || '/' ||
    case when kind = 'photo' then entity_id::text else 'avatars' end || '/' || id::text)
);
create index media_assets_household_state_idx on public.media_assets(household_id, state);
create index media_assets_creator_created_idx on public.media_assets(created_by, created_at);
create index media_assets_target_idx on public.media_assets(kind, entity_id);
alter table public.media_assets enable row level security;
revoke all on public.media_assets from public, anon, authenticated;
grant select on public.media_assets to authenticated;
create policy media_assets_select_scope on public.media_assets for select to authenticated using (
  (kind = 'profile' and owner_id = auth.uid())
  or (kind <> 'profile' and public.has_household_role(household_id))
);

alter table public.record_photos add column media_asset_id uuid references public.media_assets(id);
alter table public.profiles add column avatar_asset_id uuid references public.media_assets(id);
alter table public.households add column avatar_asset_id uuid references public.media_assets(id);
alter table public.pets add column avatar_asset_id uuid references public.media_assets(id);
create index record_photos_asset_idx on public.record_photos(media_asset_id);
create index profiles_avatar_asset_idx on public.profiles(avatar_asset_id);
create index households_avatar_asset_idx on public.households(avatar_asset_id);
create index pets_avatar_asset_idx on public.pets(avatar_asset_id);

-- Restrictive policies intersect every existing permissive Storage policy.
create policy media_storage_read_mode on storage.objects as restrictive for select to authenticated using (
  bucket_id not in ('daycare-photos','avatars') or public.get_media_storage_mode() in ('supabase','frozen')
);
create policy media_storage_insert_mode on storage.objects as restrictive for insert to authenticated with check (
  bucket_id not in ('daycare-photos','avatars') or public.get_media_storage_mode() = 'supabase'
);
create policy media_storage_update_mode on storage.objects as restrictive for update to authenticated
  using (bucket_id not in ('daycare-photos','avatars') or public.get_media_storage_mode() = 'supabase')
  with check (bucket_id not in ('daycare-photos','avatars') or public.get_media_storage_mode() = 'supabase');
create policy media_storage_delete_mode on storage.objects as restrictive for delete to authenticated using (
  bucket_id not in ('daycare-photos','avatars') or public.get_media_storage_mode() = 'supabase'
);

create function public.set_media_storage_mode(p_mode text) returns void
language plpgsql security invoker set search_path = '' as $$
declare v_mode text;
begin
  if not public.media_is_operator() then raise exception 'Operator access required' using errcode = '42501'; end if;
  if p_mode is null or p_mode not in ('supabase','frozen','gcs') then raise exception 'Invalid mode' using errcode = '22023'; end if;
  -- Drain transactions that can change objects, references, or their parent scope.
  lock table storage.objects, public.record_photos, public.profiles, public.households,
    public.pets, public.daycare_records, public.media_assets in share row exclusive mode;
  select mode into v_mode from public.media_storage_state where singleton for update;
  if v_mode <> p_mode and v_mode <> 'frozen' and p_mode <> 'frozen' then
    raise exception 'Transition requires frozen mode' using errcode = '55000';
  end if;
  update public.media_storage_state set mode = p_mode where singleton;
end;
$$;
revoke all on function public.set_media_storage_mode(text) from public, anon, authenticated;

-- Private helper: checks the actual target with elevated visibility, then locks
-- the household and membership until the caller transaction finishes.
create function public.media_write_target(p_kind text, p_entity_id uuid, p_household_id uuid, p_new_photo boolean default false)
returns table (target_household uuid, target_owner uuid)
language plpgsql security definer set search_path = '' as $$
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
revoke all on function public.media_write_target(text,uuid,uuid,boolean) from public, anon, authenticated;

create function public.media_assets_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
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
revoke all on function public.media_assets_guard() from public, anon, authenticated;
create trigger media_assets_immutable before insert or update or delete on public.media_assets
for each row execute function public.media_assets_guard();

create function public.reserve_media_upload(p_kind text, p_entity_id uuid, p_household_id uuid, p_byte_size bigint, p_content_type text)
returns jsonb language plpgsql security definer set search_path = '' as $$
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
revoke all on function public.reserve_media_upload(text,uuid,uuid,bigint,text) from public, anon;
grant execute on function public.reserve_media_upload(text,uuid,uuid,bigint,text) to authenticated;

create function public.get_media_upload(p_asset_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
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
revoke all on function public.get_media_upload(uuid) from public, anon;
grant execute on function public.get_media_upload(uuid) to authenticated;

create function public.media_retire_unreferenced(p_asset_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
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
revoke all on function public.media_retire_unreferenced(uuid) from public, anon, authenticated;

-- Every reference is checked even when the caller bypasses Server Actions and
-- invokes PostgREST directly. Metadata in this table remains a claim, not GCS proof.
create function public.media_reference_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
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
revoke all on function public.media_reference_guard() from public, anon, authenticated;
create trigger record_photos_media_guard before insert or update or delete on public.record_photos
for each row execute function public.media_reference_guard();
create trigger profiles_media_guard before insert or update or delete on public.profiles
for each row execute function public.media_reference_guard();
create trigger households_media_guard before insert or update or delete on public.households
for each row execute function public.media_reference_guard();
create trigger pets_media_guard before insert or update or delete on public.pets
for each row execute function public.media_reference_guard();

create function public.media_reference_retired() returns trigger
language plpgsql security definer set search_path = '' as $$
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
revoke all on function public.media_reference_retired() from public, anon, authenticated;
create trigger record_photos_media_retired after update or delete on public.record_photos
for each row execute function public.media_reference_retired();
create trigger profiles_media_retired after update or delete on public.profiles
for each row execute function public.media_reference_retired();
create trigger households_media_retired after update or delete on public.households
for each row execute function public.media_reference_retired();
create trigger pets_media_retired after update or delete on public.pets
for each row execute function public.media_reference_retired();

create function public.media_parent_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
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
revoke all on function public.media_parent_guard() from public, anon, authenticated;
create trigger daycare_records_media_parent_guard before update or delete on public.daycare_records
for each row execute function public.media_parent_guard();
create trigger pets_media_parent_guard before update on public.pets
for each row execute function public.media_parent_guard();
create trigger households_media_parent_guard before delete on public.households
for each row execute function public.media_parent_guard();

create function public.media_parent_deleted() returns trigger
language plpgsql security definer set search_path = '' as $$
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
revoke all on function public.media_parent_deleted() from public, anon, authenticated;
create trigger daycare_records_media_deleted after delete on public.daycare_records
for each row execute function public.media_parent_deleted();
create trigger pets_media_deleted after delete on public.pets for each row execute function public.media_parent_deleted();
create trigger profiles_media_deleted after delete on public.profiles for each row execute function public.media_parent_deleted();

create function public.commit_media_upload(p_asset_id uuid, p_generation text,
  p_expected_old_path text default null, p_expected_old_asset_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
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
$$;
revoke all on function public.commit_media_upload(uuid,text,text,uuid) from public, anon;
grant execute on function public.commit_media_upload(uuid,text,text,uuid) to authenticated;

create function public.cancel_media_upload(p_asset_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
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
revoke all on function public.cancel_media_upload(uuid) from public, anon;
grant execute on function public.cancel_media_upload(uuid) to authenticated;

create function public.delete_media_reference(p_kind text, p_entity_id uuid, p_photo_id uuid default null,
  p_expected_asset_id uuid default null, p_expected_old_path text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
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
revoke all on function public.delete_media_reference(text,uuid,uuid,uuid,text) from public, anon;
grant execute on function public.delete_media_reference(text,uuid,uuid,uuid,text) to authenticated;

create function public.media_account_deleted() returns trigger
language plpgsql security definer set search_path = '' as $$
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
revoke all on function public.media_account_deleted() from public, anon, authenticated;
create trigger users_media_deleted after delete on auth.users
for each row execute function public.media_account_deleted();
