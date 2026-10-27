// Operator-only fixed-target GCS JSON API. No token acquisition or app imports.
import { requireValue, fail, sha256, json, MAX_OBJECT_BYTES } from "./storage-backup-format.mjs";
import { failStorageHttp } from "./storage-migration-diagnostics.mjs";

export const MIGRATION_PROJECT = "mfmf-499612";
export const MIGRATION_PROJECT_NUMBER = "92772745697";
export const OPERATOR_SA = `mfmf-storage-operator@${MIGRATION_PROJECT}.iam.gserviceaccount.com`;
export const STORAGE_WIF = `projects/${MIGRATION_PROJECT_NUMBER}/locations/global/workloadIdentityPools/mfmf-storage/providers/github-storage`;
export const MIGRATION_BUCKETS = { photos: "mfmf-499612-photos", avatars: "mfmf-499612-avatars" };
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const GENERATION = /^[1-9][0-9]{0,19}$/;
export const isGeneration = (value) => typeof value === "string" && GENERATION.test(value) && BigInt(value) <= 18446744073709551615n;
export const TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"];
const API = "https://storage.googleapis.com/storage/v1";
const encode = (value) => encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const kindName = { photo: "record-photo", profile: "profile-avatar", household: "household-avatar", pet: "pet-avatar" };

export function bindingFor(asset, sourceGeneration) {
  requireValue(UUID.test(asset.id) && UUID.test(asset.entityId) && isGeneration(sourceGeneration));
  requireValue(Object.hasOwn(kindName, asset.kind));
  requireValue(asset.kind === "household" ? asset.ownerId === null && asset.householdId === asset.entityId : UUID.test(asset.ownerId));
  requireValue(asset.kind === "profile" ? asset.householdId === null && asset.entityId === asset.ownerId : UUID.test(asset.householdId));
  return {
    "mfmf-schema": "1", "mfmf-state": "ready", "mfmf-kind": kindName[asset.kind],
    "mfmf-entity-id": asset.entityId, "mfmf-household-id": asset.householdId ?? "",
    "mfmf-owner-id": asset.ownerId ?? "", "mfmf-reservation-id": asset.id,
    "mfmf-source-generation": sourceGeneration,
  };
}

export function finalKey(asset) {
  requireValue(UUID.test(asset.id) && UUID.test(asset.entityId));
  const scope = asset.kind === "profile" ? asset.ownerId : asset.householdId;
  requireValue(UUID.test(scope));
  return `${scope}/${asset.kind === "photo" ? asset.entityId : "avatars"}/${asset.id}`;
}

function objectUrl(bucket, name) {
  requireValue(Object.hasOwn(MIGRATION_BUCKETS, bucket));
  requireValue(typeof name === "string" && (/^_incoming\//.test(name)
    ? name.split("/").length === 2 && UUID.test(name.split("/")[1])
    : name.split("/").length === 3 && UUID.test(name.split("/")[0]) && UUID.test(name.split("/")[2]) &&
      (bucket === "photos" ? UUID.test(name.split("/")[1]) : name.split("/")[1] === "avatars")));
  return `${API}/b/${MIGRATION_BUCKETS[bucket]}/o/${encode(name)}`;
}

export async function responseBytes(response, limit) {
  const reader = response.body?.getReader(); requireValue(reader);
  const chunks = []; let size = 0; let complete = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { complete = true; break; }
      size += value.byteLength; requireValue(size <= limit); chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally { if (!complete) await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function createOperatorGcs({ token, fetchImpl = fetch, signal = AbortSignal.timeout(20 * 60_000) }) {
  requireValue(typeof token === "string" && token.length > 0 && token.length <= 16384 && !/[\r\n]/.test(token));
  const request = async (url, options = {}, allowMissing = false) => {
    requireValue(new URL(url).origin === "https://storage.googleapis.com");
    const response = await fetchImpl(url, { ...options, headers: { ...options.headers, Authorization: `Bearer ${token}` },
      redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) });
    if (response.status === 404 && allowMissing) { await response.body?.cancel().catch(() => {}); return null; }
    if (!response.ok) { await response.body?.cancel().catch(() => {}); failStorageHttp(response.status); }
    return response;
  };
  const readJson = async (url, options, allowMissing = false) => {
    const response = await request(url, options, allowMissing);
    return response === null ? null : json(await responseBytes(response, 65536));
  };
  const metadata = (value, bucket, name, expectedGeneration) => {
    requireValue(value && value.bucket === MIGRATION_BUCKETS[bucket] && value.name === name && isGeneration(value.generation));
    requireValue(expectedGeneration === undefined || value.generation === expectedGeneration);
    requireValue(typeof value.size === "string" && /^(0|[1-9][0-9]*)$/.test(value.size) && Number.isSafeInteger(Number(value.size)));
    requireValue(Number(value.size) <= MAX_OBJECT_BYTES);
    return value;
  };
  const stat = async (bucket, name, generation, allowMissing = false) => {
    requireValue(generation === undefined || isGeneration(generation));
    const value = await readJson(`${objectUrl(bucket, name)}${generation ? `?generation=${generation}` : ""}`, undefined, allowMissing);
    return value === null ? null : metadata(value, bucket, name, generation);
  };
  const read = async (bucket, name, generation, size) => {
    requireValue(isGeneration(generation) && Number.isSafeInteger(size) && size >= 0 && size <= MAX_OBJECT_BYTES);
    const response = await request(`${objectUrl(bucket, name)}?alt=media&generation=${generation}`, { headers: { "Accept-Encoding": "identity" } });
    if (response.headers.get("content-encoding") && response.headers.get("content-encoding") !== "identity") { await response.body?.cancel().catch(() => {}); fail(); }
    const bytes = await responseBytes(response, size); requireValue(bytes.length === size); return bytes;
  };
  const uploadIncoming = async (bucket, id, bytes, contentType) => {
    requireValue(UUID.test(id) && Buffer.isBuffer(bytes) && bytes.length <= MAX_OBJECT_BYTES && (TYPES.includes(contentType) || contentType === "application/octet-stream"));
    const name = `_incoming/${id}`;
    const url = `https://storage.googleapis.com/upload/storage/v1/b/${MIGRATION_BUCKETS[bucket]}/o?uploadType=media&name=${encode(name)}&ifGenerationMatch=0`;
    objectUrl(bucket, name);
    return metadata(await readJson(url, { method: "POST", headers: { "Content-Type": contentType }, body: bytes }), bucket, name);
  };
  const remove = async (bucket, name, generation) => {
    requireValue(isGeneration(generation));
    const response = await request(`${objectUrl(bucket, name)}?generation=${generation}&ifGenerationMatch=${generation}`, { method: "DELETE" }, true);
    await response?.body?.cancel().catch(() => {});
  };
  return {
    stat, read, uploadIncoming, remove,
    restoreIncoming: (bucket, id, bytes) => uploadIncoming(bucket, id, bytes, "application/octet-stream"),
    async restoreIncomingGeneration(bucket, name, generation) {
      requireValue(name.startsWith("_incoming/") && isGeneration(generation));
      return metadata(await readJson(`${objectUrl(bucket, name)}/restore?generation=${generation}&ifGenerationMatch=0`, { method: "POST" }), bucket, name);
    },
    async verifyBuckets() {
      for (const bucket of Object.values(MIGRATION_BUCKETS)) {
        const info = await readJson(`${API}/b/${bucket}`);
        requireValue(info.name === bucket && info.projectNumber === MIGRATION_PROJECT_NUMBER && info.location === "ASIA-NORTHEAST1" && info.storageClass === "STANDARD");
        requireValue(info.iamConfiguration?.uniformBucketLevelAccess?.enabled === true && info.iamConfiguration?.publicAccessPrevention === "enforced");
        requireValue(info.versioning?.enabled !== true && info.softDeletePolicy?.retentionDurationSeconds === "604800");
        requireValue(info.defaultEventBasedHold !== true && !info.retentionPolicy && info.billing?.requesterPays !== true);
      }
    },
    async copyAsset(asset, bytes, observe = () => {}) {
      const bucket = asset.kind === "photo" ? "photos" : "avatars";
      const max = asset.kind === "photo" ? 10 * 1024 * 1024 : 2 * 1024 * 1024;
      requireValue(bytes.length > 0 && bytes.length <= max && bytes.length === asset.size && sha256(bytes) === asset.sha256 && TYPES.includes(asset.contentType));
      const incoming = await uploadIncoming(bucket, asset.id, bytes, asset.contentType);
      await observe({ bucket, name: incoming.name, generation: incoming.generation, role: "incoming" });
      requireValue(Number(incoming.size) === bytes.length && incoming.contentType === asset.contentType);
      requireValue(sha256(await read(bucket, incoming.name, incoming.generation, bytes.length)) === asset.sha256);
      const binding = bindingFor(asset, incoming.generation);
      const name = finalKey(asset);
      const result = await readJson(`${objectUrl(bucket, incoming.name)}/rewriteTo/b/${MIGRATION_BUCKETS[bucket]}/o/${encode(name)}?sourceGeneration=${incoming.generation}&ifSourceGenerationMatch=${incoming.generation}&ifGenerationMatch=0`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentType: asset.contentType, contentEncoding: "identity", cacheControl: "private, no-store", contentDisposition: "inline", metadata: binding }),
      });
      requireValue(result.done === true); // bounded same-location rewrite, no opaque token following
      const final = metadata(result.resource, bucket, name);
      await observe({ bucket, name, generation: final.generation, role: "final" });
      const verified = await stat(bucket, name, final.generation);
      requireValue(Number(verified.size) === bytes.length && verified.contentType === asset.contentType && verified.contentEncoding === "identity");
      requireValue(verified.cacheControl === "private, no-store" && verified.contentDisposition === "inline");
      requireValue(JSON.stringify(Object.entries(verified.metadata ?? {}).sort()) === JSON.stringify(Object.entries(binding).sort()));
      requireValue(sha256(await read(bucket, name, final.generation, bytes.length)) === asset.sha256);
      return { ...asset, incomingGeneration: incoming.generation, generation: final.generation };
    },
  };
}
