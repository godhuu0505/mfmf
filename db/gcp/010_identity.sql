-- Apply as mfmf_migrator after SET ROLE mfmf_owner.
-- The verified Identity Platform account is the identity authority. This schema
-- contains only the UUID/email mirror required by existing foreign keys and RLS.
CREATE SCHEMA auth;
REVOKE ALL ON SCHEMA auth FROM PUBLIC;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, identity_sync, media_operator;

CREATE TABLE auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_subject text UNIQUE CHECK (
    provider_subject IS NULL OR (
      length(provider_subject) BETWEEN 1 AND 128
      AND provider_subject !~ '[[:cntrl:]]'
      AND provider_subject = btrim(provider_subject)
    )
  ),
  email text CHECK (email IS NULL OR (length(email) BETWEEN 1 AND 320 AND email !~ '[[:cntrl:]]')),
  email_verified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT only_verified_email CHECK (email IS NULL OR email_verified)
);
REVOKE ALL ON auth.users FROM PUBLIC, anon, authenticated, identity_sync;
ALTER TABLE auth.users ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb;
$$;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT nullif(auth.jwt()->>'sub','')::uuid;
$$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT auth.jwt()->>'role';
$$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA auth FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.jwt(), auth.role() TO anon, authenticated, identity_sync, media_operator;

CREATE FUNCTION auth.prevent_identity_rebinding() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF new.id IS DISTINCT FROM old.id OR new.provider_subject IS DISTINCT FROM old.provider_subject THEN
    RAISE EXCEPTION 'Identity binding is immutable' USING errcode='55000';
  END IF;
  RETURN new;
END;
$$;
REVOKE ALL ON FUNCTION auth.prevent_identity_rebinding() FROM PUBLIC;
CREATE TRIGGER identity_binding_immutable BEFORE UPDATE ON auth.users
  FOR EACH ROW EXECUTE FUNCTION auth.prevent_identity_rebinding();

CREATE FUNCTION public.sync_identity(p_subject text,p_email text,p_email_verified boolean,p_allow_create boolean DEFAULT false)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid; v_email text; v_existing_email text; v_existing_verified boolean;
BEGIN
  IF p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 128
    OR p_subject ~ '[[:cntrl:]]' OR p_subject <> btrim(p_subject)
    OR p_email_verified IS NULL OR p_allow_create IS NULL THEN
    RAISE EXCEPTION 'Invalid verified identity' USING errcode='22023';
  END IF;
  IF p_email_verified THEN
    IF p_email IS NULL OR length(p_email) NOT BETWEEN 1 AND 320 OR p_email ~ '[[:cntrl:]]'
      OR p_email <> btrim(p_email) THEN
      RAISE EXCEPTION 'Invalid verified identity' USING errcode='22023';
    END IF;
    v_email := lower(p_email);
  END IF;
  -- A UUID-looking imported subject must never silently claim an unbound source
  -- account. Import writes the explicit mapping before enabling the application.
  IF p_subject ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND EXISTS (SELECT 1 FROM auth.users WHERE id=p_subject::uuid AND provider_subject IS DISTINCT FROM p_subject) THEN
    RAISE EXCEPTION 'Identity import mapping is missing' USING errcode='55000';
  END IF;
  -- A frozen migration candidate may authenticate an already imported identity
  -- without changing any row, including updated_at. Hold a row lock so a delete
  -- or a competing email change cannot race this decision within the request.
  SELECT id,email,email_verified INTO v_id,v_existing_email,v_existing_verified
    FROM auth.users WHERE provider_subject=p_subject FOR UPDATE;
  IF FOUND THEN
    IF v_existing_email IS NOT DISTINCT FROM v_email AND v_existing_verified=p_email_verified THEN
      RETURN v_id;
    END IF;
    UPDATE auth.users SET email=v_email,email_verified=p_email_verified,updated_at=now() WHERE id=v_id;
    RETURN v_id;
  END IF;
  -- Only the trusted server controls p_allow_create. A provider-created account
  -- does not bypass closed registration on its second login attempt.
  IF NOT p_allow_create THEN
    RAISE EXCEPTION 'Identity registration is closed' USING errcode='42501';
  END IF;
  INSERT INTO auth.users(provider_subject,email,email_verified)
    VALUES(p_subject,v_email,p_email_verified)
  ON CONFLICT(provider_subject) DO UPDATE
    SET email=excluded.email,email_verified=excluded.email_verified,updated_at=now()
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.sync_identity(text,text,boolean,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_identity(text,text,boolean,boolean) TO identity_sync;
COMMENT ON FUNCTION public.sync_identity(text,text,boolean,boolean) IS
  'Trusted server-only identity_sync role. The server verifies IdP identity/revocation before issuing its private loopback JWT. User JWT claims are not attestation.';
