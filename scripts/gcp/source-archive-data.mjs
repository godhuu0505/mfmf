// Offline, memory-only parser for pg_restore --data-only output from an archive
// created with pg_dump --quote-all-identifiers. Never executes SQL, opens a file, logs a row or contacts a service.
import { COLUMNS } from "./database-operator.mjs";

const LIMIT = 64 * 1024 * 1024;
const MAX_ROWS = 50000;
const IDENTIFIER = '[a-z][a-z0-9_]{0,62}';
const COPY = new RegExp(`^COPY "(${IDENTIFIER})"\\."(${IDENTIFIER})" \\(("${IDENTIFIER}"(?:, "${IDENTIFIER}")*)\\) FROM stdin;$`);
const PUBLIC = Object.freeze({ ...COLUMNS, media_storage_state: ["singleton", "mode", "read_backend"] });
const AUTH_REQUIRED = Object.freeze({
  users: ["id","email","role","aud","is_anonymous","is_sso_user","is_super_admin","deleted_at","phone","phone_confirmed_at",
    "created_at","updated_at","email_confirmed_at","last_sign_in_at","encrypted_password","banned_until","raw_user_meta_data","raw_app_meta_data"],
  identities: ["id","user_id","provider","provider_id","identity_data"],
  mfa_factors: ["id","user_id","factor_type","status"],
});
// Fixed Supabase Auth v2.197.0 inventory. Unsupported credentials/configuration
// must be absent, not silently dropped; all COPY blocks must still be present.
const AUTH_EMPTY_REQUIRED = new Set([
  "mfa_factors", "mfa_challenges", "mfa_recovery_code_sets", "mfa_recovery_codes",
  "webauthn_credentials", "webauthn_challenges", "custom_oauth_providers", "oauth_clients",
  "oauth_authorizations", "oauth_consents", "oauth_client_states", "scim_users", "scim_tokens",
  "sso_providers", "sso_domains", "saml_providers", "saml_relay_states", "instances",
]);
// These sessions and pending actions expire at migration: users sign in again
// and request fresh confirmation/reset links. The encrypted source retains them.
const AUTH_TRANSIENT = new Set(["sessions", "refresh_tokens", "flow_state", "mfa_amr_claims", "one_time_tokens"]);
// History is preserved in the source archive, not imported into Identity Platform.
const AUTH_ARCHIVE_ONLY = new Set(["audit_log_entries", "schema_migrations"]);
const AUTH_TABLES = new Set([...Object.keys(AUTH_REQUIRED), ...AUTH_EMPTY_REQUIRED, ...AUTH_TRANSIENT, ...AUTH_ARCHIVE_ONLY]);
const PUBLIC_BOOLEANS = new Set(["daycare_records.guest_visible","daycare_records.overrides_rule","media_assets.is_legacy",
  "record_ranking_project_budget.singleton","media_storage_state.singleton"]);
const AUTH_BOOLEANS = new Set(["is_super_admin","is_anonymous","is_sso_user","disabled"]);
const AUTH_JSON = new Set(["raw_user_meta_data","raw_app_meta_data","identity_data","web_authn_credential"]);
const AUTH_TIMES = new Set(["created_at","updated_at","email_confirmed_at","phone_confirmed_at","confirmed_at","invited_at",
  "confirmation_sent_at","recovery_sent_at","email_change_sent_at","last_sign_in_at","phone_change_sent_at",
  "reauthentication_sent_at","deleted_at","banned_until","verified_at","last_challenged_at"]);
const SETTINGS = new Set([
  "SET statement_timeout = 0;", "SET lock_timeout = 0;", "SET idle_in_transaction_session_timeout = 0;",
  "SET transaction_timeout = 0;", "SET client_encoding = 'UTF8';", "SET standard_conforming_strings = on;",
  "SET check_function_bodies = false;", "SET xmloption = content;", "SET client_min_messages = warning;", "SET row_security = off;",
  "SET default_tablespace = '';", "SET default_table_access_method = heap;",
  "SELECT pg_catalog.set_config('search_path', '', false);",
]);
export class SourceArchiveError extends Error {
  constructor() { super("Source archive data rejected; details withheld."); this.name = "SourceArchiveError"; }
}
const requireValue = (value) => { if (!value) throw new SourceArchiveError(); };
function safe(fn) { try { return fn(); } catch { throw new SourceArchiveError(); } }
const decode = (bytes) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);

/** pg_dump COPY text subset, plus documented byte octal/hex escapes. */
export function decodeCopyField(raw) {
  return safe(() => {
    requireValue(typeof raw === "string" && raw.isWellFormed() && !/[\x00\t\r\n]/.test(raw));
    if (raw === "\\N") return null;
    const bytes = Buffer.from(raw, "utf8"), out = Buffer.allocUnsafe(bytes.length);
    let end = 0;
    for (let index = 0; index < bytes.length; index++) {
      let byte = bytes[index];
      if (byte === 92) {
        requireValue(++index < bytes.length); byte = bytes[index];
        const controls = { 98: 8, 102: 12, 110: 10, 114: 13, 116: 9, 118: 11, 92: 92 };
        if (Object.hasOwn(controls, byte)) byte = controls[byte];
        else if (byte >= 48 && byte <= 55) {
          let digits = String.fromCharCode(byte);
          while (digits.length < 3 && index + 1 < bytes.length && bytes[index + 1] >= 48 && bytes[index + 1] <= 55) digits += String.fromCharCode(bytes[++index]);
          byte = Number.parseInt(digits, 8); requireValue(byte <= 255);
        } else if (byte === 120) {
          let digits = "";
          while (digits.length < 2 && index + 1 < bytes.length && /[0-9a-f]/i.test(String.fromCharCode(bytes[index + 1]))) digits += String.fromCharCode(bytes[++index]);
          requireValue(digits.length > 0); byte = Number.parseInt(digits, 16);
        } else throw new SourceArchiveError(); // COPY TO never emits other escapes.
      }
      requireValue(byte !== 0); out[end++] = byte;
    }
    return decode(out.subarray(0, end));
  });
}

/** Preserve up to six fractional digits while normalizing a PG timestamptz to UTC. */
export function normalizeArchiveTimestamp(value) {
  return safe(() => {
    const match = typeof value === "string" && /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?(Z|[+-]\d{2}(?::\d{2})?)$/.exec(value);
    requireValue(match);
    const [,year,month,day,hour,minute,second,fraction = "",zone] = match;
    requireValue(+year >= 1970 && +month >= 1 && +month <= 12 && +day >= 1
      && +day <= new Date(Date.UTC(+year,+month,0)).getUTCDate() && +hour < 24 && +minute < 60 && +second < 60);
    const offset = zone === "Z" ? zone : zone.length === 3 ? zone + ":00" : zone;
    if (offset !== "Z") requireValue(+offset.slice(1,3) <= 15 && +offset.slice(4,6) < 60);
    const instant = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`);
    requireValue(Number.isFinite(instant) && instant >= 0);
    return new Date(instant).toISOString().slice(0,19) + fraction + "Z";
  });
}
function boolean(value) {
  requireValue(["t","f","true","false"].includes(value)); return value === "t" || value === "true";
}
function decimal(value) {
  requireValue(typeof value === "string" && value.length <= 128);
  const parts = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value); requireValue(parts);
  let digits = (parts[2] + (parts[3] ?? "")).replace(/^0+/, "");
  if (!digits) return "0";
  let power = BigInt(parts[4] ?? "0") - BigInt((parts[3] ?? "").length);
  while (digits.endsWith("0")) { digits = digits.slice(0,-1); power++; }
  return parts[1] + digits + "e" + power;
}
function json(value) {
  // JSON.parse otherwise rounds large/high-precision numbers silently. Retain
  // only JSON numbers whose decimal value survives the parameter round trip.
  return JSON.parse(value, (_key,parsed,context) => {
    if (typeof parsed === "number") requireValue(Number.isFinite(parsed) && decimal(context?.source) === decimal(JSON.stringify(parsed)));
    return parsed;
  });
}
function cell(schema,table,column,value) {
  if (value === null) return null;
  if (schema === "public") {
    if (PUBLIC_BOOLEANS.has(`${table}.${column}`)) return boolean(value);
    if (table === "feedback" && column === "context") return json(value);
    return value;
  }
  if (AUTH_BOOLEANS.has(column)) return boolean(value);
  if (AUTH_JSON.has(column)) return json(value);
  if (AUTH_TIMES.has(column)) return column === "banned_until" && value === "infinity" ? value : normalizeArchiveTimestamp(value);
  return value;
}

/** Result contains PII/secrets: caller must keep it in memory and never log it. */
export function parseSourceArchiveData(input) {
  return safe(() => {
    requireValue(Buffer.isBuffer(input) || input instanceof Uint8Array);
    requireValue(input.byteLength > 0 && input.byteLength <= LIMIT);
    const sql = decode(input);
    requireValue(!sql.includes("\0") && !sql.includes("\r")); // pg_restore COPY stdout uses LF.
    const tables = Object.fromEntries(Object.keys(COLUMNS).map(name => [name,[]]));
    const retained = { users: [], identities: [], mfaFactors: [] }, states = [];
    const seen = new Set(); let current, rowCount = 0, restrict, sequenceSeen = false;
    for (const line of sql.split("\n")) {
      if (current) {
        if (line === "\\.") { current = undefined; continue; }
        requireValue(!current.emptyRequired);
        const raw = line.split("\t");
        requireValue(raw.length === current.columns.length && ++rowCount <= MAX_ROWS);
        const values = raw.map(decodeCopyField);
        if (current.destination) current.destination.push(Object.fromEntries(current.columns.map((column,index) =>
          [column,cell(current.schema,current.table,column,values[index])])));
        continue;
      }
      if (line === "" || line.startsWith("--")) continue;
      if (SETTINGS.has(line)) continue;
      const restricted = /^\\(restrict|unrestrict) ([A-Za-z0-9]{1,128})$/.exec(line);
      if (restricted) {
        if (restricted[1] === "restrict") { requireValue(restrict === undefined); restrict = restricted[2]; }
        else { requireValue(restrict === restricted[2]); restrict = undefined; }
        continue;
      }
      // This source auth sequence belongs only to discarded refresh tokens.
      // Recognize its pg_dump metadata, never evaluate/restore the sequence.
      const sequence = /^SELECT pg_catalog\.setval\('(?:"auth"\."refresh_tokens_id_seq"|auth\.refresh_tokens_id_seq)', ([1-9][0-9]{0,18}), (true|false)\);$/.exec(line);
      if (sequence) {
        requireValue(!sequenceSeen && seen.has("auth.refresh_tokens") && BigInt(sequence[1]) <= 9223372036854775807n);
        sequenceSeen = true; continue;
      }
      const header = COPY.exec(line); requireValue(header);
      const [,schema,table,columnText] = header;
      requireValue(["public","auth"].includes(schema));
      const key = `${schema}.${table}`; requireValue(!seen.has(key)); seen.add(key);
      const columns = columnText.split(", ").map(column => column.slice(1,-1));
      requireValue(columns.length <= 256 && new Set(columns).size === columns.length);
      let destination;
      if (schema === "public") {
        requireValue(Object.hasOwn(PUBLIC,table) && columns.length === PUBLIC[table].length
          && PUBLIC[table].every(column => columns.includes(column)));
        destination = table === "media_storage_state" ? states : tables[table];
      } else {
        requireValue(AUTH_TABLES.has(table));
        if (Object.hasOwn(AUTH_REQUIRED,table)) {
          requireValue(AUTH_REQUIRED[table].every(column => columns.includes(column)));
          destination = retained[table === "mfa_factors" ? "mfaFactors" : table];
        }
      }
      current = { schema,table,columns,destination,emptyRequired: schema === "auth" && AUTH_EMPTY_REQUIRED.has(table) };
    }
    requireValue(!current && restrict === undefined && Object.keys(PUBLIC).every(name => seen.has(`public.${name}`))
      && [...AUTH_TABLES].every(name => seen.has(`auth.${name}`)));
    requireValue(states.length === 1 && states[0].singleton === true && ["supabase","frozen","gcs"].includes(states[0].mode)
      && ["supabase","gcs"].includes(states[0].read_backend));
    return { ...retained,tables,sourceMediaState: states[0] };
  });
}
