-- Storage completes uploads through a privileged DB client after its RLS probe.
-- Enforce the write freeze at the metadata write itself, including those clients.
-- This does not attest object bytes or stop version-specific cleanup already queued
-- by Storage: the operator must copy from the verified post-freeze byte backup.
create function public.media_storage_object_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if public.get_media_storage_mode() <> 'supabase' and (
    (tg_op <> 'INSERT' and old.bucket_id in ('daycare-photos', 'avatars')) or
    (tg_op <> 'DELETE' and new.bucket_id in ('daycare-photos', 'avatars'))
  ) then
    raise exception 'Source media writes are unavailable' using errcode = '55000';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function public.media_storage_object_guard() from public, anon, authenticated;

-- No operator exception: source migration, backup and rollback only read Storage.
create trigger media_storage_object_guard
before insert or update or delete on storage.objects
for each row execute function public.media_storage_object_guard();
