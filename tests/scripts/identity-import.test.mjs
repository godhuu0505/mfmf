import test from "node:test";
import assert from "node:assert/strict";
import { convertIdentityImport, toRestBatch, IdentityImportError } from "../../scripts/gcp/identity-import.mjs";

// Public, synthetic bcrypt fixture; never derived from a real account.
const HASH = "$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";
const AT = "2026-10-01T02:03:04.123456Z";
const NOW = Date.parse("2026-10-28T00:00:00Z");
const PRIVATE = "PRIVATE_INPUT_MUST_NOT_APPEAR";
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function source(n = 1, kind = "email") {
  const id = uuid(n), address = `fixture${n}@example.invalid`;
  const user = {
    id, email: address, role: "authenticated", aud: "authenticated", is_anonymous: false, is_sso_user: false,
    is_super_admin: false, deleted_at: null, phone: null, phone_confirmed_at: null,
    created_at: AT, updated_at: "2026-10-02T02:03:04Z", email_confirmed_at: AT, last_sign_in_at: null,
    encrypted_password: kind === "google" ? null : HASH, banned_until: null,
    raw_user_meta_data: {}, raw_app_meta_data: { provider: kind === "linked" ? "google" : kind, providers: kind === "linked" ? ["google", "email"] : [kind] },
    recovery_token: PRIVATE, email_change_token_new: PRIVATE, reauthentication_token: PRIVATE,
  };
  const identities = [];
  if (kind !== "google") identities.push({ id: uuid(n + 100000), user_id: id, provider: "email", provider_id: id,
    identity_data: { sub: id, email: address, email_verified: true } });
  if (kind !== "email") identities.push({ id: uuid(n + 200000), user_id: id, provider: "google", provider_id: `google-sub-${n}`,
    identity_data: { sub: `google-sub-${n}`, provider_id: `google-sub-${n}`, email: address, email_verified: true,
      name: "架空アカウント", picture: "https://example.invalid/fixture.jpg" } });
  return { user, identities };
}
function input(...accounts) {
  if (!accounts.length) accounts = [source()];
  return { users: accounts.map((account) => account.user), identities: accounts.flatMap((account) => account.identities), mfaFactors: [], targetUsers: [] };
}
const convert = (value) => convertIdentityImport(value, { now: NOW });
function rejects(value, code) {
  assert.throws(() => convert(value), (error) => {
    assert.ok(error instanceof IdentityImportError);
    if (code) assert.equal(error.code, code);
    assert.match(error.message, /^Identity import rejected \([a-z_]+\); input withheld\.$/);
    assert.equal(error.message.includes(PRIVATE), false);
    assert.equal(error.stack.includes(PRIVATE), false);
    assert.equal(error.cause, undefined);
    return true;
  });
}

test("linked Google + password preserves UUID, exact bcrypt bytes, provider UID, verified email and six mirror columns", () => {
  const fixture = input(source(1, "linked"));
  const result = convert(fixture), record = result.batches[0].users[0];
  assert.equal(record.uid, uuid(1));
  assert.equal(record.passwordHash.toString("utf8"), HASH);
  assert.deepEqual(result.batches[0].options, { hash: { algorithm: "BCRYPT" } });
  assert.equal(record.providerData[0].uid, "google-sub-1");
  assert.notEqual(record.providerData[0].uid, fixture.identities[1].id);
  assert.equal(record.providerData[0].providerId, "google.com");
  assert.equal(record.emailVerified, true);
  assert.equal(record.displayName, "架空アカウント");
  assert.deepEqual(result.authMirror, [{ id: uuid(1), provider_subject: uuid(1), email: "fixture1@example.invalid",
    email_verified: true, created_at: AT, updated_at: fixture.users[0].updated_at }]);
  assert.deepEqual(result.summary, { users: 1, passwordUsers: 1, googleUsers: 1, linkedUsers: 1, verifiedEmails: 1,
    disabledUsers: 0, futureTimedBans: 0, consentRecords: 0, batches: 1 });
});

test("Google-only batch needs no SDK password options; REST still supplies required algorithm", () => {
  const result = convert(input(source(1, "google")));
  assert.equal(result.batches[0].options, undefined);
  assert.equal(result.batches[0].users[0].passwordHash, undefined);
  assert.equal(toRestBatch(result.batches[0]).hashAlgorithm, "BCRYPT");
});

test("Google account with a password but no email identity keeps both usable credentials", () => {
  const fixture = input(source(1, "google")); fixture.users[0].encrypted_password = HASH;
  const result = convert(fixture);
  assert.equal(result.summary.linkedUsers, 1);
  assert.ok(result.batches[0].users[0].passwordHash);
});

test("source primary confirmation is authoritative, not generic confirmed_at or another provider email", () => {
  const fixture = input(source(1, "google"));
  fixture.users[0].email_confirmed_at = null;
  fixture.users[0].confirmed_at = AT;
  fixture.identities[0].identity_data.email = "other-provider@example.invalid";
  const result = convert(fixture);
  assert.equal(result.batches[0].users[0].emailVerified, false);
  assert.equal(result.batches[0].users[0].providerData[0].email, "other-provider@example.invalid");
  assert.equal(result.authMirror[0].email, null);
  assert.equal(result.authMirror[0].email_verified, false);
});

test("preserves consent evidence only when present and leaves profiles to full DB restore", () => {
  const fixture = input(source());
  fixture.users[0].raw_user_meta_data = { tos_accepted_at: AT, display_name: "架空表示名", avatar_url: "https://example.invalid/a.png", role: "admin", nested: PRIVATE };
  fixture.users[0].raw_app_meta_data.custom_claims = { admin: true };
  const result = convert(fixture), user = result.batches[0].users[0];
  assert.deepEqual(user.customClaims, { tos_accepted_at: AT });
  assert.equal(user.displayName, "架空表示名");
  assert.equal(user.photoURL, "https://example.invalid/a.png");
  assert.equal(result.summary.consentRecords, 1);
  assert.equal(JSON.stringify(result).includes(PRIVATE), false);
  assert.equal(user.role, undefined);
  assert.equal(convert(input()).batches[0].users[0].customClaims, undefined);
});

test("future, permanent and explicit bans remain disabled; expired bans do not remain disabled", () => {
  const fixture = input(source(1), source(2), source(3), source(4));
  fixture.users[0].banned_until = "2027-01-01T00:00:00Z";
  fixture.users[1].banned_until = "infinity";
  fixture.users[2].banned_until = "2026-01-01T00:00:00Z";
  fixture.users[3].disabled = true;
  const result = convert(fixture);
  assert.deepEqual(result.batches[0].users.map((user) => user.disabled), [true, true, false, true]);
  assert.equal(result.summary.disabledUsers, 3);
  assert.equal(result.summary.futureTimedBans, 1);
});

test("conversion does not modify the original archive rows", () => {
  const fixture = input(source(1, "linked")), before = structuredClone(fixture);
  convert(fixture);
  assert.deepEqual(fixture, before);
});

test("REST conversion is a fixed whitelist with no source tokens, no raw password and overwrite disabled", () => {
  const fixture = input(source(1, "linked"));
  fixture.users[0].last_sign_in_at = AT;
  fixture.users[0].raw_user_meta_data.tos_accepted_at = AT;
  const result = toRestBatch(convert(fixture).batches[0]);
  assert.equal(result.sanityCheck, true); assert.equal(result.allowOverwrite, false);
  assert.deepEqual(Object.keys(result).sort(), ["allowOverwrite", "hashAlgorithm", "sanityCheck", "users"]);
  const user = result.users[0];
  assert.equal(user.localId, uuid(1));
  assert.equal(Buffer.from(user.passwordHash, "base64").toString("utf8"), HASH);
  assert.equal(user.createdAt, String(Date.parse(AT))); assert.equal(user.lastLoginAt, user.createdAt);
  assert.deepEqual(user.providerUserInfo, [{ providerId: "google.com", rawId: "google-sub-1", email: "fixture1@example.invalid",
    displayName: "架空アカウント", photoUrl: "https://example.invalid/fixture.jpg" }]);
  assert.deepEqual(JSON.parse(user.customAttributes), { tos_accepted_at: AT });
  assert.equal(user.rawPassword, undefined); assert.equal(user.passwordSalt, undefined); assert.equal(user.salt, undefined);
  assert.equal(JSON.stringify(result).includes(PRIVATE), false);
});

test("validates all users before returning and splits only after global collision checks", () => {
  const fixture = input(...Array.from({ length: 1001 }, (_, index) => source(index + 1, "google")));
  const result = convert(fixture);
  assert.deepEqual(result.batches.map((batch) => batch.users.length), [1000, 1]);
  assert.equal(result.summary.users, 1001); assert.equal(result.authMirror.length, 1001);
  assert.equal(result.batches[1].options, undefined);
  fixture.users[1000].email = fixture.users[0].email;
  rejects(fixture, "duplicate_identity");
});

for (const [name, mutate, code] of [
  ["source UID duplicate", (x) => { x.users.push(structuredClone(x.users[0])); }, "duplicate_identity"],
  ["case-insensitive email duplicate", (x) => { x.users[1].email = x.users[0].email.toUpperCase(); }, "duplicate_identity"],
  ["provider email owned by another source account", (x) => { x.identities[1].identity_data.email = x.users[0].email; }, "duplicate_identity"],
  ["identity row duplicate", (x) => { x.identities.push(structuredClone(x.identities[0])); }, "duplicate_identity"],
  ["Google UID duplicate", (x) => { x.identities[1].provider_id = x.identities[0].provider_id; x.identities[1].identity_data.sub = x.identities[0].provider_id; x.identities[1].identity_data.provider_id = x.identities[0].provider_id; }, "duplicate_identity"],
  ["multiple Google providers for one user", (x) => { x.identities[1].user_id = x.users[0].id; }, "duplicate_identity"],
  ["orphan identity", (x) => { x.identities[0].user_id = uuid(99); }, "invalid_input"],
  ["provider identity subject mismatch", (x) => { x.identities[0].identity_data.sub = PRIVATE; }, "invalid_input"],
  ["provider identity extra provider_id mismatch", (x) => { x.identities[0].identity_data.provider_id = PRIVATE; }, "invalid_input"],
  ["Admin REST identity confused with SQL row", (x) => { x.identities[0].id = x.identities[0].provider_id; delete x.identities[0].provider_id; }, "invalid_input"],
  ["Google identity verification missing", (x) => { delete x.identities[0].identity_data.email_verified; }, "invalid_input"],
  ["target UID collision", (x) => { x.targetUsers.push({ uid: x.users[0].id, providerData: [] }); }, "target_collision"],
  ["target primary email collision", (x) => { x.targetUsers.push({ uid: "target-only", email: x.users[0].email.toUpperCase(), providerData: [] }); }, "target_collision"],
  ["target provider email collision", (x) => { x.targetUsers.push({ uid: "target-only", providerData: [{ providerId: "google.com", uid: "unrelated", email: x.users[0].email }] }); }, "target_collision"],
  ["target Google UID collision", (x) => { x.targetUsers.push({ uid: "target-only", providerData: [{ providerId: "google.com", uid: x.identities[0].provider_id }] }); }, "target_collision"],
]) test(`rejects ${name}`, () => { const fixture = input(source(1, "google"), source(2, "google")); mutate(fixture); rejects(fixture, code); });

for (const [name, mutate, code] of [
  ["MFA even when unverified", (x) => { x.mfaFactors.push({ user_id: x.users[0].id, status: "unverified", secret: PRIVATE }); }, "mfa_present"],
  ["missing MFA table", (x) => { delete x.mfaFactors; }, "invalid_input"],
  ["MFA assertion instead of rows", (x) => { x.mfaFactors = { checked: true }; }, "invalid_input"],
  ["missing target snapshot", (x) => { delete x.targetUsers; }, "invalid_input"],
  ["anonymous source", (x) => { x.users[0].is_anonymous = true; }, "unsupported_account"],
  ["missing anonymous field", (x) => { delete x.users[0].is_anonymous; }, "unsupported_account"],
  ["SSO source", (x) => { x.users[0].is_sso_user = true; }, "unsupported_account"],
  ["superuser source", (x) => { x.users[0].is_super_admin = true; }, "unsupported_account"],
  ["soft deleted source", (x) => { x.users[0].deleted_at = AT; }, "unsupported_account"],
  ["phone method", (x) => { x.users[0].phone = "+15555555555"; }, "unsupported_account"],
  ["privileged source role", (x) => { x.users[0].role = "service_role"; }, "unsupported_account"],
  ["unsupported provider row", (x) => { x.identities[0].provider = PRIVATE; }, "unsupported_provider"],
  ["unsupported advertised provider", (x) => { x.users[0].raw_app_meta_data.providers.push("saml"); }, "unsupported_provider"],
  ["missing advertised linked identity", (x) => { x.users[0].raw_app_meta_data.providers.push("google"); }, "unsupported_provider"],
  ["missing all identities", (x) => { x.identities = []; }, "unsupported_account"],
  ["passwordless-only account", (x) => { x.users[0].encrypted_password = ""; }, "unsupported_password"],
  ["encrypted bcrypt wrapper", (x) => { x.users[0].encrypted_password = `v1:${PRIVATE}`; }, "unsupported_password"],
  ["Argon2 credential", (x) => { x.users[0].encrypted_password = `$argon2id$${PRIVATE}`; }, "unsupported_password"],
  ["bcrypt cost out of bounds", (x) => { x.users[0].encrypted_password = HASH.replace("$10$", "$32$"); }, "unsupported_password"],
  ["bcrypt non-string", (x) => { x.users[0].encrypted_password = [HASH]; }, "invalid_input"],
  ["missing required timestamp", (x) => { delete x.users[0].updated_at; }, "invalid_input"],
  ["timestamp without timezone", (x) => { x.users[0].created_at = "2026-10-01T00:00:00"; }, "invalid_input"],
  ["invalid calendar date", (x) => { x.users[0].created_at = "2026-02-30T00:00:00Z"; }, "invalid_input"],
  ["sub-microsecond precision unsupported by DB mirror", (x) => { x.users[0].created_at = "2026-10-01T00:00:00.1234567Z"; }, "invalid_input"],
  ["invalid consent", (x) => { x.users[0].raw_user_meta_data.tos_accepted_at = PRIVATE; }, "invalid_input"],
  ["invalid avatar URL", (x) => { x.users[0].raw_user_meta_data.picture = `javascript:${PRIVATE}`; }, "invalid_input"],
  ["avatar URL credentials", (x) => { x.users[0].raw_user_meta_data.picture = `https://${PRIVATE}@example.invalid/a`; }, "invalid_input"],
  ["UUID casing would change mapping", (x) => { x.users[0].id = "AAAA0000-0000-4000-8000-000000000001"; }, "invalid_input"],
  ["email with controls", (x) => { x.users[0].email = `${PRIVATE}\n@example.invalid`; }, "invalid_input"],
]) test(`fails closed for ${name}`, () => { const fixture = input(); mutate(fixture); rejects(fixture, code); });

test("unrelated target identities are retained and do not collide", () => {
  const fixture = input(); fixture.targetUsers = [{ uid: "unrelated", email: "different@example.invalid", providerData: [] }];
  assert.equal(convert(fixture).summary.users, 1);
});

test("passwordless email identity linked to Google is rejected rather than silently losing email-link sign-in", () => {
  const fixture = input(source(1, "linked")); fixture.users[0].encrypted_password = null;
  rejects(fixture, "unsupported_password");
});

for (const [name, mutate] of [
  ["unsafe extra REST field", (batch) => { batch.users[0].rawPassword = PRIVATE; }],
  ["unapproved claim", (batch) => { batch.users[0].customClaims = { admin: true }; }],
  ["hash string instead of exact bytes", (batch) => { batch.users[0].passwordHash = HASH; }],
  ["hash bytes modified", (batch) => { batch.users[0].passwordHash[0] = 65; }],
  ["hash algorithm changed", (batch) => { batch.options.hash.algorithm = "SCRYPT"; }],
  ["salt added", (batch) => { batch.options.hash.salt = PRIVATE; }],
  ["duplicate records", (batch) => { batch.users.push(batch.users[0]); }],
  ["unknown provider", (batch) => { batch.users[0].providerData = [{ providerId: "saml", uid: PRIVATE }]; }],
  ["missing creation timestamp", (batch) => { delete batch.users[0].metadata.creationTime; }],
  ["empty batch", (batch) => { batch.users = []; }],
  ["oversized batch", (batch) => { batch.users = Array(1001).fill(batch.users[0]); }],
]) test(`REST adapter rejects ${name} without exposing input`, () => {
  const batch = convert(input()).batches[0]; mutate(batch);
  assert.throws(() => toRestBatch(batch), (error) => {
    assert.ok(error instanceof IdentityImportError);
    assert.equal(error.message.includes(PRIVATE), false);
    assert.equal(error.message.includes(HASH), false);
    return true;
  });
});

test("even unexpected getter/URL exceptions are replaced with a fixed safe error", () => {
  const fixture = input(); Object.defineProperty(fixture.users[0], "email", { get() { throw new Error(PRIVATE); } });
  rejects(fixture, "invalid_input");
  assert.equal(new IdentityImportError(PRIVATE).code, "invalid_input");
  assert.throws(() => convertIdentityImport(input(), { get now() { throw new Error(PRIVATE); } }),
    (error) => error instanceof IdentityImportError && !error.stack.includes(PRIVATE));
});

test("invalid time and options fail closed without invoking user-controlled conversion", () => {
  for (const options of [null, { now: -1 }, { now: Infinity }, { now: PRIVATE }, { now: NOW, unexpected: PRIVATE }]) {
    assert.throws(() => convertIdentityImport(input(), options), IdentityImportError);
  }
});

test("REST conversion has no side effects on the reusable SDK payload", () => {
  const batch = convert(input(source(1, "linked"))).batches[0];
  const first = toRestBatch(batch); first.users[0].email = "changed@example.invalid";
  assert.equal(toRestBatch(batch).users[0].email, "fixture1@example.invalid");
  assert.equal(batch.users[0].passwordHash.toString("utf8"), HASH);
});
