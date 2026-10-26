-- Shared avatars follow the same write roles as records and pet profiles.
-- The original policies checked membership without a role, so a viewer could
-- bypass the UI and insert/delete household avatar objects through Storage.
-- Personal avatars remain writable by their user, regardless of household role.
-- SELECT is unchanged: all household members may read shared avatars.

alter policy "avatars_insert_scope" on storage.objects
  with check (
    bucket_id = 'avatars'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or public.has_household_role(
        public.try_cast_uuid((storage.foldername(name))[1]),
        array['owner', 'editor']
      )
    )
  );

alter policy "avatars_delete_scope" on storage.objects
  using (
    bucket_id = 'avatars'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or public.has_household_role(
        public.try_cast_uuid((storage.foldername(name))[1]),
        array['owner', 'editor']
      )
    )
  );
