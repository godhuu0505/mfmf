-- Test-only platform scaffolding for replaying ALL historical migrations in a
-- separate source database. It is NEVER installed in the GCP application DB.
-- No auth/storage bytes or platform behavior is mocked by the GCP baseline.
CREATE SCHEMA auth;
CREATE SCHEMA storage;
CREATE SCHEMA extensions;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid
$$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb
$$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT auth.jwt()->>'role' $$;
CREATE TABLE storage.buckets(id text PRIMARY KEY, name text, public boolean);
CREATE TABLE storage.objects(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text REFERENCES storage.buckets(id),
 name text, owner uuid, metadata jsonb, version text
);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
 SELECT (string_to_array(name,'/'))[1:array_length(string_to_array(name,'/'),1)-1]
$$;
GRANT USAGE ON SCHEMA auth,storage,extensions TO anon,authenticated,service_role;
GRANT ALL ON storage.objects,storage.buckets TO anon,authenticated,service_role;
