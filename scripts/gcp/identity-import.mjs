// Offline conversion only: never fetch, read files, log records, or import users here.
// SQL auth.identities.provider_id is the provider UID; its id is a different UUID.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BCRYPT = /^\$2[aby]\$(?:0[4-9]|[12][0-9]|3[01])\$[./A-Za-z0-9]{53}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_USERS = 10000;
const CODES = new Set(["invalid_input", "unsupported_account", "unsupported_provider", "unsupported_password", "mfa_present", "duplicate_identity", "target_collision", "invalid_batch"]);

export class IdentityImportError extends Error {
  constructor(code = "invalid_input") {
    const safeCode = CODES.has(code) ? code : "invalid_input";
    super(`Identity import rejected (${safeCode}); input withheld.`);
    this.name = "IdentityImportError";
    this.code = safeCode;
  }
}
function requireValue(ok, code = "invalid_input") { if (!ok) throw new IdentityImportError(code); }
function safe(operation) {
  try { return operation(); } catch (error) {
    // Do not propagate JSON/parser/SDK exceptions, causes, or input-derived strings.
    throw new IdentityImportError(error instanceof IdentityImportError ? error.code : "invalid_input");
  }
}
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function keys(value, allowed) { return object(value) && Object.keys(value).every((key) => allowed.includes(key)); }
function text(value, maximum = 255) {
  requireValue(typeof value === "string" && value.length > 0 && value.length <= maximum && value === value.trim() && !CONTROL.test(value));
  return value;
}
function uuid(value) { requireValue(typeof value === "string" && UUID.test(value)); return value; }
function email(value) {
  const result = text(value, 255);
  requireValue(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result));
  return result.toLowerCase();
}
function date(value) {
  requireValue(typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value));
  const ms = Date.parse(value);
  requireValue(Number.isFinite(ms) && ms >= 0);
  // Date.parse normalizes invalid calendar dates. Reject them before conversion.
  const [year, month, day, hour, minute, second] = value.slice(0, 19).split(/[-T:]/).map(Number);
  requireValue(month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
    && hour <= 23 && minute <= 59 && second <= 59);
  return value;
}
function optionalDate(value) { return value === null ? undefined : date(value); }
function metadata(value) { requireValue(object(value)); return value; }
function optionalText(value, maximum = 255) {
  return value === undefined || value === null || value === "" ? undefined : text(value, maximum);
}
function photo(value) {
  const result = optionalText(value, 2048);
  if (!result) return undefined;
  const parsed = new URL(result);
  requireValue(["https:", "http:"].includes(parsed.protocol) && !parsed.username && !parsed.password);
  return result;
}
function claimEmail(map, value, owner, code = "duplicate_identity") {
  const normalized = email(value);
  requireValue(!map.has(normalized) || map.get(normalized) === owner, code);
  map.set(normalized, owner);
  return normalized;
}
function claimUnique(set, value, code = "duplicate_identity") {
  requireValue(!set.has(value), code); set.add(value);
}
function validateAppMetadata(meta) {
  if (meta.provider !== undefined) requireValue(["email", "google"].includes(meta.provider), "unsupported_provider");
  if (meta.providers !== undefined) requireValue(Array.isArray(meta.providers) && meta.providers.length > 0
    && meta.providers.every((provider) => ["email", "google"].includes(provider))
    && new Set(meta.providers).size === meta.providers.length, "unsupported_provider");
}
function claims(meta) {
  // Application code writes this evidence at signup; it does not gate RLS on it.
  // Never manufacture consent or copy arbitrary user-controlled roles/claims.
  return meta.tos_accepted_at === undefined || meta.tos_accepted_at === null
    ? undefined : { tos_accepted_at: date(meta.tos_accepted_at) };
}
function validateTarget(rows) {
  requireValue(Array.isArray(rows) && rows.length <= MAX_USERS);
  const uids = new Set(), emails = new Map(), googleIds = new Set();
  for (const row of rows) {
    requireValue(object(row));
    const id = text(row.uid, 128);
    claimUnique(uids, id, "target_collision");
    if (row.email !== undefined && row.email !== null) claimEmail(emails, row.email, id, "target_collision");
    requireValue(Array.isArray(row.providerData));
    for (const provider of row.providerData) {
      requireValue(object(provider)); text(provider.providerId); text(provider.uid);
      if (provider.email !== undefined && provider.email !== null) claimEmail(emails, provider.email, id, "target_collision");
      if (provider.providerId === "google.com") claimUnique(googleIds, provider.uid, "target_collision");
    }
  }
  return { uids, emails, googleIds };
}

/**
 * Convert complete SQL row snapshots and a complete Admin listUsers snapshot.
 * All returned batches contain secrets/PII and must remain in operator memory.
 * No external mutation is performed; all rows validate before any batch returns.
 */
export function convertIdentityImport(input, options = {}) {
  return safe(() => {
    requireValue(keys(options, ["now"]));
    const now = options.now === undefined ? Date.now() : options.now;
    requireValue(keys(input, ["users", "identities", "mfaFactors", "targetUsers"])
      && Array.isArray(input.users) && input.users.length > 0 && input.users.length <= MAX_USERS
      && Array.isArray(input.identities) && input.identities.length <= MAX_USERS * 2
      && Array.isArray(input.mfaFactors) && Number.isFinite(now) && now >= 0);
    requireValue(input.mfaFactors.length === 0, "mfa_present");
    const target = validateTarget(input.targetUsers);
    const rows = new Map(), emails = new Map(), providerIds = new Set(), identityIds = new Set();
    const converted = [], authMirror = [];
    const summary = { users: input.users.length, passwordUsers: 0, googleUsers: 0, linkedUsers: 0,
      verifiedEmails: 0, disabledUsers: 0, futureTimedBans: 0, consentRecords: 0, batches: 0 };

    for (const source of input.users) {
      requireValue(object(source));
      const id = uuid(source.id);
      requireValue(!rows.has(id), "duplicate_identity");
      requireValue(!target.uids.has(id), "target_collision");
      requireValue(source.is_anonymous === false && source.is_sso_user === false
        && (source.is_super_admin === false || source.is_super_admin == null) && source.deleted_at == null
        && (source.phone == null || source.phone === "") && source.phone_confirmed_at == null
        && source.role === "authenticated" && source.aud === "authenticated", "unsupported_account");
      if (source.disabled !== undefined) requireValue(typeof source.disabled === "boolean");
      const primaryEmail = claimEmail(emails, source.email, id);
      requireValue(!target.emails.has(primaryEmail), "target_collision");
      const createdAt = date(source.created_at), updatedAt = date(source.updated_at);
      const verified = optionalDate(source.email_confirmed_at) !== undefined;
      const lastSignIn = optionalDate(source.last_sign_in_at);
      const userMeta = metadata(source.raw_user_meta_data), appMeta = metadata(source.raw_app_meta_data);
      validateAppMetadata(appMeta);
      const bannedUntil = source.banned_until === "infinity" ? "infinity" : optionalDate(source.banned_until);
      const timedBan = bannedUntil !== undefined && bannedUntil !== "infinity" && Date.parse(bannedUntil) > now;
      const disabled = source.disabled === true || bannedUntil === "infinity" || timedBan;
      requireValue(source.encrypted_password === null || typeof source.encrypted_password === "string");
      const hash = source.encrypted_password || undefined;
      if (hash) requireValue(BCRYPT.test(hash), "unsupported_password");
      const customClaims = claims(userMeta);
      const record = {
        uid: id, email: primaryEmail, emailVerified: verified, disabled,
        metadata: { creationTime: new Date(createdAt).toISOString(), ...(lastSignIn ? { lastSignInTime: new Date(lastSignIn).toISOString() } : {}) },
        ...(hash ? { passwordHash: Buffer.from(hash, "utf8") } : {}),
        ...(customClaims ? { customClaims } : {}),
      };
      rows.set(id, { source, record, userMeta, providers: new Set() });
      converted.push(record);
      authMirror.push({ id, provider_subject: id, email: verified ? primaryEmail : null,
        email_verified: verified, created_at: createdAt, updated_at: updatedAt });
      if (hash) summary.passwordUsers++;
      if (verified) summary.verifiedEmails++;
      if (disabled) summary.disabledUsers++;
      if (timedBan) summary.futureTimedBans++;
      if (customClaims) summary.consentRecords++;
    }
    for (const identity of input.identities) {
      requireValue(object(identity));
      claimUnique(identityIds, uuid(identity.id));
      const owner = rows.get(uuid(identity.user_id));
      requireValue(owner !== undefined);
      requireValue(["email", "google"].includes(identity.provider), "unsupported_provider");
      claimUnique(owner.providers, identity.provider);
      const data = metadata(identity.identity_data), providerId = text(identity.provider_id);
      requireValue(data.sub === providerId);
      if (data.provider_id !== undefined) requireValue(data.provider_id === providerId);
      claimUnique(providerIds, `${identity.provider}:${providerId}`);
      if (identity.provider === "email") {
        requireValue(providerId === owner.record.uid);
        if (data.email !== undefined) requireValue(email(data.email) === owner.record.email);
        // Passwordless email-only identities would lose an authentication method.
        requireValue(Buffer.isBuffer(owner.record.passwordHash), "unsupported_password");
      } else {
        requireValue(!target.googleIds.has(providerId), "target_collision");
        requireValue(typeof data.email_verified === "boolean");
        const providerEmail = claimEmail(emails, data.email, owner.record.uid);
        requireValue(!target.emails.has(providerEmail), "target_collision");
        const displayName = optionalText(data.full_name ?? data.name);
        const photoURL = photo(data.avatar_url ?? data.picture);
        owner.record.providerData = [{ providerId: "google.com", uid: providerId, email: providerEmail,
          ...(displayName ? { displayName } : {}), ...(photoURL ? { photoURL } : {}) }];
        summary.googleUsers++;
      }
    }
    for (const { record, userMeta, providers, source } of rows.values()) {
      requireValue(providers.size > 0, "unsupported_account");
      const advertised = source.raw_app_meta_data.providers;
      if (advertised) requireValue(advertised.every((provider) => providers.has(provider)), "unsupported_provider");
      if (source.raw_app_meta_data.provider) requireValue(providers.has(source.raw_app_meta_data.provider), "unsupported_provider");
      const displayName = optionalText(userMeta.display_name ?? userMeta.full_name ?? userMeta.name) ?? record.providerData?.[0]?.displayName;
      const photoURL = photo(userMeta.avatar_url ?? userMeta.picture) ?? record.providerData?.[0]?.photoURL;
      if (displayName) record.displayName = displayName;
      if (photoURL) record.photoURL = photoURL;
      if (record.passwordHash && record.providerData) summary.linkedUsers++;
    }
    const batches = [];
    for (let offset = 0; offset < converted.length; offset += 1000) {
      const users = converted.slice(offset, offset + 1000);
      batches.push({ users, ...(users.some((row) => row.passwordHash) ? { options: { hash: { algorithm: "BCRYPT" } } } : {}) });
    }
    summary.batches = batches.length;
    return { batches, authMirror, summary };
  });
}

/** Fixed REST v1 projects.accounts:batchCreate body; never sends a request. */
export function toRestBatch(batch) {
  return safe(() => {
    requireValue(keys(batch, ["users", "options"]) && Array.isArray(batch.users)
      && batch.users.length > 0 && batch.users.length <= 1000, "invalid_batch");
    const hasHash = batch.users.some((row) => object(row) && row.passwordHash !== undefined);
    requireValue(hasHash ? keys(batch.options, ["hash"]) && keys(batch.options.hash, ["algorithm"])
      && batch.options.hash.algorithm === "BCRYPT" : batch.options === undefined, "invalid_batch");
    const ids = new Set(), emails = new Map(), providers = new Set();
    const users = batch.users.map((row) => {
      requireValue(keys(row, ["uid", "email", "emailVerified", "disabled", "metadata", "passwordHash", "providerData", "customClaims", "displayName", "photoURL"]), "invalid_batch");
      const localId = uuid(row.uid); claimUnique(ids, localId);
      requireValue(typeof row.emailVerified === "boolean" && typeof row.disabled === "boolean", "invalid_batch");
      const result = { localId, email: claimEmail(emails, row.email, localId), emailVerified: row.emailVerified, disabled: row.disabled };
      requireValue(keys(row.metadata, ["creationTime", "lastSignInTime"]), "invalid_batch");
      result.createdAt = String(Date.parse(date(row.metadata.creationTime)));
      if (row.metadata.lastSignInTime !== undefined) result.lastLoginAt = String(Date.parse(date(row.metadata.lastSignInTime)));
      if (row.passwordHash !== undefined) {
        requireValue(Buffer.isBuffer(row.passwordHash) && row.passwordHash.length === 60
          && BCRYPT.test(row.passwordHash.toString("utf8")), "invalid_batch");
        result.passwordHash = row.passwordHash.toString("base64");
      }
      if (row.displayName !== undefined) result.displayName = text(row.displayName);
      if (row.photoURL !== undefined) result.photoUrl = photo(row.photoURL);
      if (row.customClaims !== undefined) {
        requireValue(keys(row.customClaims, ["tos_accepted_at"]) && Object.keys(row.customClaims).length === 1, "invalid_batch");
        result.customAttributes = JSON.stringify({ tos_accepted_at: date(row.customClaims.tos_accepted_at) });
      }
      if (row.providerData !== undefined) {
        requireValue(Array.isArray(row.providerData) && row.providerData.length === 1, "invalid_batch");
        const provider = row.providerData[0];
        requireValue(keys(provider, ["providerId", "uid", "email", "displayName", "photoURL"])
          && provider.providerId === "google.com", "invalid_batch");
        const rawId = text(provider.uid); claimUnique(providers, rawId);
        const mapped = { providerId: "google.com", rawId, email: claimEmail(emails, provider.email, localId) };
        if (provider.displayName !== undefined) mapped.displayName = text(provider.displayName);
        if (provider.photoURL !== undefined) mapped.photoUrl = photo(provider.photoURL);
        result.providerUserInfo = [mapped];
      }
      requireValue(result.passwordHash !== undefined || result.providerUserInfo !== undefined, "invalid_batch");
      return result;
    });
    // REST declares hashAlgorithm required even when this batch has only OAuth users.
    return { hashAlgorithm: "BCRYPT", sanityCheck: true, allowOverwrite: false, users };
  });
}
