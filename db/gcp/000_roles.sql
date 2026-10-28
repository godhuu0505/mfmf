-- Run once as the Cloud SQL provisioning administrator, in a new database.
-- No password or IAM principal is embedded here. The operator configures LOGIN
-- credentials separately. Existing role names fail closed instead of being reused.
CREATE ROLE mfmf_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE anon NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE authenticated NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE identity_sync NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE media_operator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE authenticator LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE mfmf_migrator LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE mfmf_operator LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT anon, authenticated, identity_sync TO authenticator;
GRANT mfmf_owner, media_operator TO mfmf_migrator;
GRANT media_operator TO mfmf_operator;
-- Applies to all PostgREST transactions, including inherited request roles.
ALTER ROLE authenticator SET statement_timeout = '8s';
ALTER ROLE authenticator SET idle_in_transaction_session_timeout = '10s';
GRANT mfmf_owner TO CURRENT_USER;
DO $$ BEGIN
  EXECUTE format('GRANT CREATE ON DATABASE %I TO mfmf_owner', current_database());
END $$;
ALTER SCHEMA public OWNER TO mfmf_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA extensions AUTHORIZATION mfmf_owner;
CREATE EXTENSION pg_trgm WITH SCHEMA extensions;
GRANT USAGE ON SCHEMA extensions TO mfmf_owner, authenticated, anon;
