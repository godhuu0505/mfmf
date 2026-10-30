// Ciphertext only. No credentials file, plaintext file, overwrite or deletion.
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { BACKUP_PROJECT, BACKUP_NUMBER, IDENTITY_BUCKET, BackupJobError, requireBackup as need, responseBytes } from "./backup-job-config.mjs";
import { FIXED as IDENTITY } from "./identity-backup.mjs";
const BASE = `https://storage.googleapis.com/storage/v1/b/${IDENTITY_BUCKET}`;
const MAX_BYTES = 17 * 1024 * 1024;
const sha = (value) => createHash("sha256").update(value).digest("hex");
const AGE_HEADER = Buffer.from("age-encryption.org/v1\n");
function validTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) return false;
  const normalized = new Date(value).toISOString();
  return normalized.replace(/\.000Z$/, "Z") === value.replace(/\.0{1,3}Z$/, "Z")
    || normalized === value.replace(/\.(\d{1,2})Z$/, (_, n) => `.${n.padEnd(3, "0")}Z`);
}
export function validateIdentityBucket(b) {
  need(b?.name === IDENTITY_BUCKET && b.projectNumber === BACKUP_NUMBER && b.location === "ASIA-NORTHEAST1" && b.storageClass === "STANDARD"
    && b.iamConfiguration?.uniformBucketLevelAccess?.enabled === true && b.iamConfiguration.publicAccessPrevention === "enforced"
    && /^[1-9][0-9]{0,19}$/.test(b.metageneration ?? "")
    && !b.versioning?.enabled && !b.defaultEventBasedHold && !b.autoclass?.enabled && !b.encryption
    && b.softDeletePolicy?.retentionDurationSeconds === "604800" && b.retentionPolicy?.retentionPeriod === "2592000"
    && isDeepStrictEqual(b.lifecycle?.rule, [{ action: { type: "Delete" }, condition: { age: 30, matchesPrefix: ["identity/"] } }]), "bucket");
  return b;
}
export async function publishIdentityBackup({ ciphertext, receipt, token, execution, sourceCommit, fetchImpl = fetch, now = () => Date.now() }) {
  need(Buffer.isBuffer(ciphertext) && ciphertext.length > 100 && ciphertext.length <= MAX_BYTES
    && ciphertext.subarray(0, AGE_HEADER.length).equals(AGE_HEADER), "archive");
  need(/^mfmf-identity-backup-[a-z0-9]{5,20}$/.test(execution ?? "") && /^[a-f0-9]{40}$/.test(sourceCommit ?? "")
    && typeof token === "string" && token.length > 0 && token.length <= 16384 && !/[\s\x00-\x1f\x7f-\uffff]/.test(token), "context");
  const completed = Date.parse(receipt?.sourceCompletedAt);
  need(receipt?.format === "mfmf-idp-backup-receipt-v1" && receipt.status === "encrypted" && receipt.projectId === BACKUP_PROJECT
    && receipt.projectNumber === BACKUP_NUMBER && receipt.ciphertextSha256 === sha(ciphertext) && receipt.ciphertextBytes === ciphertext.length
    && Number.isFinite(completed) && completed >= now() - 15 * 60000 && completed <= now() + 30000
    && receipt.plaintextPersisted === false && receipt.restoreVerified === false && receipt.twoPassEqual === true, "archive");
  // Serialize a strict public projection. Extra properties never enter a log/object.
  const allowed = ["format", "status", "projectId", "projectNumber", "archive", "createdAt", "sourceStartedAt", "sourceCompletedAt",
    "ciphertextSha256", "ciphertextBytes", "recipientSha256", "users", "googleLinked", "scryptPasswords", "bcryptPasswords",
    "passwordResetRequired", "noPassword", "disabled", "twoPassEqual", "atomicSnapshot", "cloudMutations", "plaintextPersisted", "restoreVerified"];
  need(Object.keys(receipt).length === allowed.length && allowed.every((k) => Object.hasOwn(receipt, k)), "archive");
  for (const k of ["users", "googleLinked", "scryptPasswords", "bcryptPasswords", "passwordResetRequired", "noPassword", "disabled"]) need(Number.isInteger(receipt[k]) && receipt[k] >= 0 && receipt[k] <= 1000, "archive");
  need(receipt.archive === IDENTITY.archive && receipt.recipientSha256 === sha(IDENTITY.recipient)
    && receipt.atomicSnapshot === false && receipt.cloudMutations === 0 && receipt.users > 0
    && receipt.scryptPasswords + receipt.bcryptPasswords + receipt.passwordResetRequired + receipt.noPassword === receipt.users
    && receipt.googleLinked <= receipt.users && receipt.disabled <= receipt.users
    && [receipt.createdAt, receipt.sourceStartedAt, receipt.sourceCompletedAt].every(validTimestamp)
    && Date.parse(receipt.sourceStartedAt) <= completed && Date.parse(receipt.createdAt) >= completed
    && Date.parse(receipt.createdAt) <= now() + 30000, "archive");
  const day = new Date(completed).toISOString().slice(0, 10);
  const object = `identity/${day}/${execution}.json.age`;
  const receiptObject = `identity/${day}/${execution}.receipt.json`;
  const api = async (url, stage, method = "GET", bytes, contentType = "application/octet-stream", raw = false) => {
    let response;
    try { response = await fetchImpl(url, { method, redirect: "error", signal: AbortSignal.timeout(60000),
      headers: { Authorization: `Bearer ${token}`, "X-Goog-User-Project": BACKUP_PROJECT, ...(bytes ? { "Content-Type": contentType } : {}) },
      ...(bytes ? { body: bytes } : {}) }); } catch { throw new BackupJobError(stage); }
    if (!response.ok) { try { await response.body?.cancel(); } catch { /* Fixed status only. */ } throw new BackupJobError(stage, response.status); }
    const result = await responseBytes(response, stage, raw ? MAX_BYTES : 262144);
    if (raw) return result;
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result)); } catch { throw new BackupJobError(stage); }
  };
  const initial = validateIdentityBucket(await api(BASE, "bucket"));
  const metadata = (value, name, size) => {
    need(value?.bucket === IDENTITY_BUCKET && value.name === name && /^[1-9][0-9]{0,19}$/.test(value.generation ?? "") && value.size === String(size)
      && !value.kmsKeyName && !value.customerEncryption && !value.eventBasedHold && !value.temporaryHold
      && Date.parse(value.retentionExpirationTime) >= now() + 29 * 86400000, "readback"); return value;
  };
  const upload = (name, bytes, type) => api(`https://storage.googleapis.com/upload/storage/v1/b/${IDENTITY_BUCKET}/o?uploadType=media&name=${encodeURIComponent(name)}&ifGenerationMatch=0`, "upload", "POST", bytes, type);
  const uploaded = metadata(await upload(object, ciphertext, "application/octet-stream"), object, ciphertext.length);
  const readback = await api(`${BASE}/o/${encodeURIComponent(object)}?alt=media&generation=${uploaded.generation}`, "readback", "GET", undefined, undefined, true);
  need(readback.length === ciphertext.length && sha(readback) === receipt.ciphertextSha256, "readback");
  const finalBucket = validateIdentityBucket(await api(BASE, "bucket"));
  need(initial.metageneration === finalBucket.metageneration, "bucket");
  const stored = { format: "mfmf-idp-stored-backup-v1", projectId: BACKUP_PROJECT, bucket: IDENTITY_BUCKET, object,
    generation: uploaded.generation, execution, sourceCommit, storedAt: new Date(now()).toISOString(),
    encryptedBytesReadbackVerified: true, recoveryKeyStoredInJob: false, backup: Object.fromEntries(allowed.map((k) => [k, receipt[k]])) };
  const bytes = Buffer.from(JSON.stringify(stored));
  const proof = metadata(await upload(receiptObject, bytes, "application/json"), receiptObject, bytes.length);
  const checked = await api(`${BASE}/o/${encodeURIComponent(receiptObject)}?alt=media&generation=${proof.generation}`, "receipt");
  need(isDeepStrictEqual(checked, stored), "receipt");
  return { status: "stored", bucket: IDENTITY_BUCKET, object, generation: uploaded.generation, receiptObject, receiptGeneration: proof.generation,
    ciphertextSha256: receipt.ciphertextSha256, ciphertextBytes: ciphertext.length, users: receipt.users, passwordResetRequired: receipt.passwordResetRequired,
    encryptedBytesReadbackVerified: true, restoreVerified: false };
}
