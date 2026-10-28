-- Applied as mfmf_owner, after the baseline. No implicit PUBLIC function grants.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, anon, authenticated, identity_sync;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated, identity_sync;
GRANT USAGE ON SCHEMA public TO anon, authenticated, identity_sync, media_operator;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.daycare_records, public.feedback,
 public.google_credentials, public.guest_grants, public.household_invites,
 public.household_members, public.households, public.pets, public.profiles,
 public.record_assignees, public.record_photos, public.record_tags,
 public.schedule_rule_assignees, public.schedule_rule_skips, public.tags TO authenticated;
-- Published schedule rules are immutable; replacement is a checked RPC.
GRANT SELECT, INSERT, DELETE ON public.schedule_rules TO authenticated;
GRANT SELECT ON public.media_assets TO authenticated;
GRANT EXECUTE ON FUNCTION public.accept_household_invite(p_token text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_media_upload(p_asset_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.commit_media_upload(p_asset_id uuid, p_generation text, p_expected_old_path text, p_expected_old_asset_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_own_household(p_name text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_media_reference(p_kind text, p_entity_id uuid, p_photo_id uuid, p_expected_asset_id uuid, p_expected_old_path text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_own_household(p_household_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_plan(p_record uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_record_keeping_skip(p_record uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_household_guests(p_household uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_household_members(p_household uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_media_read_backend() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_media_read_backend() TO anon;
GRANT EXECUTE ON FUNCTION public.get_media_storage_mode() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_media_storage_mode() TO anon;
GRANT EXECUTE ON FUNCTION public.get_media_upload(p_asset_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_guest_access(p_household uuid, p_pet uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_guest_record_access(p_household uuid, p_pet uuid, p_record_date date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_household_role(target_household uuid, allowed_roles text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_household_member(target_household uuid, target_user uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.jst_today() TO authenticated;
GRANT EXECUTE ON FUNCTION public.jst_today() TO anon;
GRANT EXECUTE ON FUNCTION public.replace_schedule_rule(p_household uuid, p_weekday smallint, p_since date, p_kind text, p_start time without time zone, p_end time without time zone, p_assignees jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_media_upload(p_kind text, p_entity_id uuid, p_household_id uuid, p_byte_size bigint, p_content_type text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_record_ranking(p_household uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.schedule_rules_for_range(p_household uuid, p_from date, p_to date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.try_cast_uuid(value text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_identity(text,text,boolean,boolean) TO identity_sync;
GRANT EXECUTE ON FUNCTION public.media_is_operator(), public.set_media_storage_mode(text) TO media_operator;
-- Operator SQL never grants runtime an administrative capability.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO media_operator;
GRANT INSERT, UPDATE ON public.media_assets TO media_operator;
GRANT UPDATE ON public.media_storage_state TO media_operator;
CREATE POLICY media_assets_operator ON public.media_assets TO media_operator
 USING (public.media_is_operator()) WITH CHECK (public.media_is_operator());
CREATE POLICY media_state_operator ON public.media_storage_state TO media_operator
 USING (public.media_is_operator()) WITH CHECK (public.media_is_operator());
-- FORCE RLS counters were previously owned by a superuser. Preserve the force
-- boundary with a policy only for the NOLOGIN, non-runtime function owner.
CREATE POLICY ranking_project_owner ON public.record_ranking_project_budget TO mfmf_owner USING (true) WITH CHECK (true);
CREATE POLICY ranking_user_owner ON public.record_ranking_user_budget TO mfmf_owner USING (true) WITH CHECK (true);
INSERT INTO public.record_ranking_project_budget(singleton,usage_day) VALUES(true,date '1970-01-01');
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA auth REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
