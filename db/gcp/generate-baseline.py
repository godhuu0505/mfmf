from pathlib import Path
import re,json,hashlib,sys
r=Path(__file__).resolve().parents[2]
source=Path(sys.argv[1])
s=source.read_text()
# pg_dump object blocks preserve every table, constraint, index, policy and function.
blocks=re.split(r'(?=--\n-- Name: )',s)
kept=[]
for b in blocks:
 if b.startswith('--\n-- Name: '):
  title=b.splitlines()[1]
  if 'Type: DEFAULT ACL;' in title or 'Type: ACL;' in title: continue
  if 'Name: public; Type: SCHEMA;' in title or 'Name: SCHEMA public; Type: COMMENT;' in title: continue
  if 'Name: media_storage_object_guard();' in title: continue
 kept.append(b)
s=''.join(kept)
s=re.sub(r'^\\(?:un)?restrict .*\n','',s,flags=re.M)
s=s.replace('SET row_security = off;','SET row_security = on;')
old="""     or exists (
          select 1 from storage.objects o
          where o.bucket_id = 'daycare-photos'
            and (storage.foldername(o.name))[1] = p_household_id::text
        ) then"""
new="""     or exists (
          select 1 from public.media_assets a
          where a.household_id = p_household_id and a.state <> 'deleted'
        ) then"""
assert s.count(old)==1;s=s.replace(old,new)
s=s.replace('  -- Storage の残存レースについては 20260705040000 のコメントを参照（#51 へ委ねる）。','  -- GCS reservations and ready assets must be retired before household deletion.')
old="""  select auth.uid() is null and exists (
    select 1 from pg_catalog.pg_roles where rolname = session_user and (rolsuper or rolbypassrls)
  );"""
new="""  select auth.uid() is null
    and pg_catalog.pg_has_role(session_user, 'media_operator', 'MEMBER');"""
assert s.count(old)==1;s=s.replace(old,new)
start=s.index('CREATE FUNCTION public.set_media_storage_mode(')
end=s.index('$$;',start)+3
s=s[:start]+"""CREATE FUNCTION public.set_media_storage_mode(p_mode text) RETURNS void
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
$$;"""+s[end:]
s=s.replace("  select mode from public.media_storage_state where singleton;","  select coalesce((select mode from public.media_storage_state where singleton),'frozen');")
s=s.replace("    mode text DEFAULT 'supabase'::text NOT NULL,", "    mode text DEFAULT 'frozen'::text NOT NULL,")
s=s.replace("    read_backend text DEFAULT 'supabase'::text NOT NULL,", "    read_backend text DEFAULT 'gcs'::text NOT NULL,")
s=s.replace("ARRAY['supabase'::text, 'frozen'::text, 'gcs'::text]", "ARRAY['frozen'::text, 'gcs'::text]")
s=s.replace("ARRAY['supabase'::text, 'gcs'::text]", "ARRAY['gcs'::text]")
assert not re.search(r'\bstorage\.',s)
# auth trigger is not emitted by a public-only schema dump; explicitly restore it.
s += """
-- GCP baseline additions. User claims/ready ledger never attest GCS bytes.
CREATE TRIGGER users_media_deleted AFTER DELETE ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.media_account_deleted();
INSERT INTO public.media_storage_state(singleton,mode,read_backend) VALUES(true,'frozen','gcs');
RESET check_function_bodies;
"""
header="""-- Reviewed GCP baseline: source public schema at repository f69dc9a697ec4fdd85c6a00555ffa894bc1a5210.
-- Source: isolated PostgreSQL 17, ALL source migrations through 20261028010000.
-- Reproduced using tests/gcp/source-shim.sql only in the source proof database.
-- No source data is included. Apply only to an empty database after 010_identity.sql.
-- All 20 public tables / 70 policies retained; one obsolete Storage trigger function removed.
-- Differences: GCS-only state, explicit operator role, GCS ledger household guard,
-- auth deletion trigger, and least-privilege ACLs supplied separately in 030_permissions.sql.
-- Historical Supabase migrations remain unchanged and are NOT replayed here.
\n"""
(r/'db/gcp/020_public.sql').write_text(header+s)
manifest={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted((r/'supabase/migrations').glob('*.sql'))}
(r/'db/gcp/source-migrations.json').write_text(json.dumps(manifest,indent=2)+'\n')
# Retain only original end-user EXECUTE grants. Trigger functions are intentionally private.
funcs=[]
for match in re.finditer(r'^GRANT ALL ON FUNCTION (.+) TO (authenticated|anon);$',source.read_text(),re.M):
 signature,role=match.groups()
 name=signature.split('(')[0].split('.')[-1]
 if name in ['enforce_last_owner','forbid_owner_change','prune_schedule_assignments','set_updated_at']: continue
 funcs.append(f'GRANT EXECUTE ON FUNCTION {signature} TO {role};')
(r/'db/gcp/030_permissions.sql').write_text("""-- Applied as mfmf_owner, after the baseline. No implicit PUBLIC function grants.
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
"""+'\n'.join(funcs)+"""
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
""")
print('public tables',s.count('CREATE TABLE public.'),'public policies',s.count('CREATE POLICY '),'baseline generated')
