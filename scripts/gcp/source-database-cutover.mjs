// Source-only operator boundary. These constants contain no user data and accept
// no SQL, relation names, role names or database addresses from the caller.
export const SOURCE_TABLES = Object.freeze([
  "daycare_records", "feedback", "google_credentials", "guest_grants", "household_invites", "household_members",
  "households", "media_assets", "media_storage_state", "pets", "profiles", "record_assignees", "record_photos",
  "record_ranking_project_budget", "record_ranking_user_budget", "record_tags", "schedule_rule_assignees", "schedule_rule_skips", "schedule_rules", "tags",
]);
const TABLES = [...SOURCE_TABLES.map((name) => `public.${name}`), "auth.users", "auth.identities"];
const LOCK = `LOCK TABLE ${TABLES.join(",")} IN SHARE ROW EXCLUSIVE MODE;`;
const EXPECTED = `ARRAY[${SOURCE_TABLES.map((name) => `'${name}'`).join(",")}]::text[]`;
const CHECK = `DO $check$ BEGIN
  IF session_user NOT IN ('postgres','supabase_admin') OR current_user <> 'postgres' OR current_database() <> 'postgres' THEN
    RAISE EXCEPTION 'Source cutover identity rejected' USING ERRCODE='42501';
  END IF;
  IF (SELECT array_agg(c.relname::text ORDER BY c.relname) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p','f')) IS DISTINCT FROM ${EXPECTED} THEN
    RAISE EXCEPTION 'Source cutover table set differs' USING ERRCODE='55000';
  END IF;
END $check$;`;
const OWNERSHIP = `DO $owner$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles r ON r.oid=n.nspowner
    WHERE n.nspname='mfmf_cutover' AND r.rolname='postgres') THEN
    RAISE EXCEPTION 'Source cutover owner differs' USING ERRCODE='55000';
  END IF;
END $owner$;`;
export const INSPECT_CUTOVER_SCHEMA_SQL = "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname='mfmf_cutover');";
export const INSPECT_CUTOVER_STATE_SQL = `SELECT frozen, (SELECT count(*) FROM pg_catalog.pg_trigger
  WHERE tgname='mfmf_cutover_write_guard' AND NOT tgisinternal AND tgenabled='A'
    AND tgfoid='mfmf_cutover.guard_source_write()'::regprocedure AND tgrelid IN (${TABLES.map((name) => `'${name}'::regclass`).join(",")}))
  FROM mfmf_cutover.state WHERE singleton=true;`;

export const FREEZE_SOURCE_SQL = `BEGIN;
SET LOCAL lock_timeout='10000'; SET LOCAL statement_timeout='60000';
${CHECK}
${LOCK}
CREATE SCHEMA IF NOT EXISTS mfmf_cutover AUTHORIZATION postgres;
${OWNERSHIP}
REVOKE ALL ON SCHEMA mfmf_cutover FROM PUBLIC;
CREATE TABLE IF NOT EXISTS mfmf_cutover.state(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), frozen boolean NOT NULL);
REVOKE ALL ON mfmf_cutover.state FROM PUBLIC;
INSERT INTO mfmf_cutover.state(singleton,frozen) VALUES(true,true)
  ON CONFLICT(singleton) DO UPDATE SET frozen=true;
CREATE OR REPLACE FUNCTION mfmf_cutover.guard_source_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $guard$
DECLARE blocked boolean;
BEGIN
  IF session_user IN ('postgres','supabase_admin') THEN RETURN NULL; END IF;
  -- FOR SHARE also rejects an old repeatable-read transaction rather than
  -- trusting an old false state. Missing state always fails closed.
  SELECT frozen INTO blocked FROM mfmf_cutover.state WHERE singleton=true FOR SHARE;
  IF COALESCE(blocked,true) THEN
    RAISE EXCEPTION 'Source database is frozen for migration' USING ERRCODE='55000';
  END IF;
  RETURN NULL;
END $guard$;
REVOKE ALL ON FUNCTION mfmf_cutover.guard_source_write() FROM PUBLIC;
${TABLES.map((name) => `CREATE OR REPLACE TRIGGER mfmf_cutover_write_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON ${name}
  FOR EACH STATEMENT EXECUTE FUNCTION mfmf_cutover.guard_source_write();
ALTER TABLE ${name} ENABLE ALWAYS TRIGGER mfmf_cutover_write_guard;`).join("\n")}
COMMIT;
${INSPECT_CUTOVER_STATE_SQL}`;

export const UNFREEZE_SOURCE_SQL = `BEGIN;
SET LOCAL lock_timeout='10000'; SET LOCAL statement_timeout='60000';
${CHECK}
${LOCK}
${OWNERSHIP}
DO $state$ BEGIN
  IF (SELECT count(*) FROM mfmf_cutover.state WHERE singleton=true) <> 1 OR
    (SELECT count(*) FROM pg_catalog.pg_trigger WHERE tgname='mfmf_cutover_write_guard' AND NOT tgisinternal
      AND tgenabled='A' AND tgfoid='mfmf_cutover.guard_source_write()'::regprocedure
      AND tgrelid IN (${TABLES.map((name) => `'${name}'::regclass`).join(",")})) <> 22 THEN
    RAISE EXCEPTION 'Source cutover state differs' USING ERRCODE='55000';
  END IF;
END $state$;
UPDATE mfmf_cutover.state SET frozen=false WHERE singleton=true;
COMMIT;
${INSPECT_CUTOVER_STATE_SQL}`;

export function parseBackupOperation(text) {
  let event;
  try { if (typeof text !== "string" || Buffer.byteLength(text) > 65_536) throw new Error(); event = JSON.parse(text); }
  catch { throw new Error("Invalid backup operation; input withheld."); }
  const operation = event?.inputs?.operation ?? "preserve";
  if (!["preserve", "freeze-and-backup", "unfreeze"].includes(operation)) throw new Error("Invalid backup operation; input withheld.");
  return operation;
}
