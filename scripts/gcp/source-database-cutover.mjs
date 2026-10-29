// Source-only operator boundary. These constants contain no user data and accept
// no SQL, relation names, role names or database addresses from the caller.
export const SOURCE_TABLES = Object.freeze([
  "daycare_records", "feedback", "google_credentials", "guest_grants", "household_invites", "household_members",
  "households", "media_assets", "media_storage_state", "pets", "profiles", "record_assignees", "record_photos",
  "record_ranking_project_budget", "record_ranking_user_budget", "record_tags", "schedule_rule_assignees", "schedule_rule_skips", "schedule_rules", "tags",
]);
export const SOURCE_AUTH_TABLES = Object.freeze(["auth.users", "auth.identities", "auth.mfa_factors",
  "auth.mfa_recovery_code_sets", "auth.mfa_recovery_codes", "auth.webauthn_credentials"]);
const TABLES = [...SOURCE_TABLES.map((name) => `public.${name}`), ...SOURCE_AUTH_TABLES];
export const SOURCE_GUARD_COUNT = TABLES.length;
const REPLICATION_ROLES = ["supabase_auth_admin", "authenticator", "anon", "authenticated", "service_role"];
// Catalog-only diagnostics: fixed table identities, no application rows or role
// names are returned. TRIGGER grants alone do not permit ENABLE ALWAYS TRIGGER;
// ALTER TABLE additionally needs ownership (including inherited owner rights).
export const INSPECT_SOURCE_CAPABILITIES_SQL = `BEGIN READ ONLY;
SET LOCAL statement_timeout='10000';
WITH expected(schema_name,table_name) AS (VALUES
  ${TABLES.map((name) => `('${name.split(".")[0]}','${name.split(".")[1]}')`).join(",")}
), capabilities AS (
  SELECT e.schema_name,e.table_name,c.oid IS NOT NULL AS present,
    COALESCE(pg_catalog.pg_has_role(current_user,c.relowner,'USAGE'),false) AS owner_rights,
    COALESCE(pg_catalog.has_table_privilege(current_user,c.oid,'TRIGGER'),false) AS trigger_rights,
    COALESCE(pg_catalog.has_table_privilege(current_user,c.oid,'UPDATE,DELETE,TRUNCATE'),false) AS lock_rights
  FROM expected e
  LEFT JOIN pg_catalog.pg_namespace n ON n.nspname=e.schema_name
  LEFT JOIN pg_catalog.pg_class c ON c.relnamespace=n.oid AND c.relname=e.table_name AND c.relkind IN ('r','p','f')
)
SELECT current_setting('transaction_read_only')='on',current_setting('default_transaction_read_only')='on',
  (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname=current_user),
  pg_catalog.has_database_privilege(current_user,current_database(),'CREATE'),
  pg_catalog.has_schema_privilege(current_user,'public','USAGE'),pg_catalog.has_schema_privilege(current_user,'auth','USAGE'),
  ${["present", "owner_rights", "trigger_rights", "lock_rights"].map((column) => `count(*) FILTER (WHERE schema_name='public' AND ${column})`).join(",")},
  ${SOURCE_AUTH_TABLES.flatMap((name) => ["present", "owner_rights", "trigger_rights", "lock_rights"].map((column) =>
    `bool_and(${column}) FILTER (WHERE schema_name='auth' AND table_name='${name.split(".")[1]}')`)).join(",")},
  ${REPLICATION_ROLES.flatMap((role) => [
    `EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='${role}')`,
    `COALESCE((SELECT pg_catalog.has_parameter_privilege(oid,'session_replication_role','SET') FROM pg_catalog.pg_roles WHERE rolname='${role}'),false)`,
  ]).join(",")}
FROM capabilities;
COMMIT;`;

export function parseSourceCapabilities(text) {
  const values = typeof text === "string" ? text.split("|") : [];
  if (values.length !== 44 || !values.slice(0, 6).concat(values.slice(10)).every((v) => /^[tf]$/.test(v))
    || !values.slice(6, 10).every((v) => /^(?:[0-9]|1[0-9]|20)$/.test(v)) || values[0] !== "t") {
    throw new Error("Invalid source capability shape; values withheld.");
  }
  const table = (offset) => Object.fromEntries(["present", "owner", "trigger", "lock"].map((key, i) => [key, values[offset + i] === "t"]));
  return { transactionReadOnly: true, defaultReadOnly: values[1] === "t", superuser: values[2] === "t",
    databaseCreate: values[3] === "t", publicUsage: values[4] === "t", authUsage: values[5] === "t",
    publicTables: Object.fromEntries(["present", "owner", "trigger", "lock"].map((key, i) => [key, Number(values[6 + i])])),
    auth: { users: table(10), identities: table(14), mfaFactors: table(18),
      mfaRecoveryCodeSets: table(22), mfaRecoveryCodes: table(26), webauthnCredentials: table(30) },
    replicationRoles: Object.fromEntries(REPLICATION_ROLES.map((role, i) => [role,
      { present: values[34 + i * 2] === "t", canSetReplicationRole: values[35 + i * 2] === "t" }])) };
}

export const CUTOVER_STEPS = Object.freeze(["transaction", "identity", "lock", "schema", "state", "function", "safety", "validate", "unfreeze-state", "commit", "inspect",
  ...TABLES.flatMap((name) => (name.startsWith("public.") ? ["create", "enable"] : ["create"]).map((verb) => `${verb}-${name.replace(".", "-")}`))]);
const progress = (step) => `SELECT 'mfmf-cutover:${step}';`;
export function parseCutoverProgress(text) {
  const lines = text.trim() ? text.trim().split("\n") : [];
  let substage = "transaction";
  let result;
  for (const line of lines) {
    const match = /^mfmf-cutover:([a-z_-]+)$/.exec(line);
    if (match && CUTOVER_STEPS.includes(match[1]) && result === undefined) substage = match[1];
    else if (/^[tf]\|26\|20\|6$/.test(line) && result === undefined) result = line;
    else throw new Error("Invalid source cutover progress; values withheld.");
  }
  return { substage, result };
}
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
// ORIGIN triggers are equivalent for these runtime roles only while this
// catalog boundary holds. MEMBER is deliberately conservative: even a NOINHERIT
// role reachable via SET ROLE must not grant a way to suppress these triggers.
// No role, grant, GUC or Auth ownership is changed by this script.
const REPLICATION_SAFETY = `DO $safety$ BEGIN
  IF current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999 THEN
    RAISE EXCEPTION 'Source replication proof requires PostgreSQL 17' USING ERRCODE='55000';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname IN (${REPLICATION_ROLES.map((name) => `'${name}'`).join(",")})) <> 5 THEN
    RAISE EXCEPTION 'Source runtime role set differs' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles runtime JOIN pg_catalog.pg_roles reachable
      ON runtime.oid=reachable.oid OR pg_catalog.pg_has_role(runtime.oid,reachable.oid,'MEMBER')
      WHERE runtime.rolname IN (${REPLICATION_ROLES.map((name) => `'${name}'`).join(",")})
        AND (reachable.rolsuper OR
          pg_catalog.has_parameter_privilege(reachable.oid,'session_replication_role','SET'))) THEN
    RAISE EXCEPTION 'Source runtime replication privilege differs' USING ERRCODE='55000';
  END IF;
  -- An operator role/database/session override can hide the underlying server
  -- default. Reject that ambiguity instead of assuming runtime sessions match.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_settings WHERE name='session_replication_role'
      AND setting IN ('origin','local') AND reset_val IN ('origin','local')
      AND source IN ('default','environment variable','configuration file','command line')) THEN
    RAISE EXCEPTION 'Source server replication default differs' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting d
      CROSS JOIN LATERAL pg_catalog.unnest(d.setconfig) setting(value)
      WHERE (d.setdatabase=0 OR d.setdatabase=(SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database()))
        AND (d.setrole=0 OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles runtime
          JOIN pg_catalog.pg_roles configured ON configured.oid=d.setrole
          WHERE runtime.rolname IN (${REPLICATION_ROLES.map((name) => `'${name}'`).join(",")})
            AND (runtime.oid=configured.oid OR pg_catalog.pg_has_role(runtime.oid,configured.oid,'MEMBER'))))
        AND pg_catalog.split_part(setting.value,'=',1)='session_replication_role'
        AND setting.value NOT IN ('session_replication_role=origin','session_replication_role=local')) THEN
    RAISE EXCEPTION 'Source role replication default differs' USING ERRCODE='55000';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_roles r ON r.oid=c.relowner
      WHERE c.oid IN (${SOURCE_AUTH_TABLES.map((name) => `'${name}'::regclass`).join(",")})
        AND c.relkind='r' AND r.rolname='supabase_auth_admin') <> 6 THEN
    RAISE EXCEPTION 'Source Auth ownership differs' USING ERRCODE='55000';
  END IF;
END $safety$;`;
// CREATE OR REPLACE may normalize a pre-existing trigger's mode on some
// versions. Do not silently repair a disabled/replica managed Auth trigger.
const EXISTING_AUTH_MODES = `DO $modes$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgname='mfmf_cutover_write_guard'
      AND tgrelid IN (${SOURCE_AUTH_TABLES.map((name) => `'${name}'::regclass`).join(",")})
      AND tgenabled<>'O') THEN
    RAISE EXCEPTION 'Source existing Auth trigger mode differs' USING ERRCODE='55000';
  END IF;
END $modes$;`;
const GUARDS = `SELECT t.tgrelid,n.nspname,t.tgenabled FROM pg_catalog.pg_trigger t
  JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE t.tgname='mfmf_cutover_write_guard' AND NOT t.tgisinternal AND t.tgtype=62
    AND t.tgnargs=0 AND t.tgqual IS NULL AND t.tgattr::text=''
    AND t.tgfoid='mfmf_cutover.guard_source_write()'::regprocedure
    AND t.tgrelid IN (${TABLES.map((name) => `'${name}'::regclass`).join(",")})
    AND ((n.nspname='public' AND t.tgenabled='A') OR (n.nspname='auth' AND t.tgenabled='O'))`;
const VALIDATE_GUARDS = `DO $state$ BEGIN
  IF (SELECT count(*) FROM mfmf_cutover.state WHERE singleton=true) <> 1 OR
    (SELECT count(*) FROM (${GUARDS}) guards) <> ${SOURCE_GUARD_COUNT} THEN
    RAISE EXCEPTION 'Source cutover state differs' USING ERRCODE='55000';
  END IF;
END $state$;`;
const STATE_RESULT = `SELECT frozen,(SELECT count(*) FROM (${GUARDS}) guards),
  (SELECT count(*) FROM (${GUARDS}) guards WHERE nspname='public'),
  (SELECT count(*) FROM (${GUARDS}) guards WHERE nspname='auth')
  FROM mfmf_cutover.state WHERE singleton=true;`;
export const INSPECT_CUTOVER_SCHEMA_SQL = "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname='mfmf_cutover');";
// Every fresh backup/inspection repeats the conditional ORIGIN-trigger proof.
export const INSPECT_CUTOVER_STATE_SQL = `BEGIN READ ONLY;
SET LOCAL statement_timeout='10000';
${CHECK}
${OWNERSHIP}
${REPLICATION_SAFETY}
${VALIDATE_GUARDS}
${STATE_RESULT}
COMMIT;`;

export const FREEZE_SOURCE_SQL = `BEGIN READ WRITE;
SET LOCAL lock_timeout='10000'; SET LOCAL statement_timeout='60000';
${progress('identity')}
${CHECK}
${progress('lock')}
${LOCK}
${progress('safety')}
${REPLICATION_SAFETY}
${EXISTING_AUTH_MODES}
${progress('schema')}
CREATE SCHEMA IF NOT EXISTS mfmf_cutover AUTHORIZATION postgres;
${OWNERSHIP}
REVOKE ALL ON SCHEMA mfmf_cutover FROM PUBLIC;
${progress('state')}
CREATE TABLE IF NOT EXISTS mfmf_cutover.state(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), frozen boolean NOT NULL);
REVOKE ALL ON mfmf_cutover.state FROM PUBLIC;
INSERT INTO mfmf_cutover.state(singleton,frozen) VALUES(true,true)
  ON CONFLICT(singleton) DO UPDATE SET frozen=true;
${progress('function')}
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
${TABLES.map((name) => `${progress(`create-${name.replace(".", "-")}`)}
CREATE OR REPLACE TRIGGER mfmf_cutover_write_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON ${name}
  FOR EACH STATEMENT EXECUTE FUNCTION mfmf_cutover.guard_source_write();
${name.startsWith("public.") ? `${progress(`enable-${name.replace(".", "-")}`)}\nALTER TABLE ${name} ENABLE ALWAYS TRIGGER mfmf_cutover_write_guard;` : ""}`).join("\n")}
${progress('validate')}
${REPLICATION_SAFETY}
${VALIDATE_GUARDS}
${progress('commit')}
COMMIT;
${progress('inspect')}
${INSPECT_CUTOVER_STATE_SQL}`;

export const UNFREEZE_SOURCE_SQL = `BEGIN READ WRITE;
SET LOCAL lock_timeout='10000'; SET LOCAL statement_timeout='60000';
${progress('identity')}
${CHECK}
${progress('lock')}
${LOCK}
${progress('safety')}
${REPLICATION_SAFETY}
${EXISTING_AUTH_MODES}
${progress('schema')}
${OWNERSHIP}
${progress('unfreeze-state')}
${VALIDATE_GUARDS}
UPDATE mfmf_cutover.state SET frozen=false WHERE singleton=true;
${progress('commit')}
COMMIT;
${progress('inspect')}
${INSPECT_CUTOVER_STATE_SQL}`;

export function parseBackupOperation(text) {
  let event;
  try { if (typeof text !== "string" || Buffer.byteLength(text) > 65_536) throw new Error(); event = JSON.parse(text); }
  catch { throw new Error("Invalid backup operation; input withheld."); }
  const operation = event?.inputs?.operation ?? "preserve";
  if (!["preserve", "freeze-and-backup", "unfreeze"].includes(operation)) throw new Error("Invalid backup operation; input withheld.");
  return operation;
}
