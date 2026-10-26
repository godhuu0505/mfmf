// Operator archive format. This module has no credentials, network or file writes.
import { createHash } from "node:crypto";
import { reconcileStorageManifest } from "./reconcile-storage-manifest.mjs";

export const SOURCE_REF = "aqvmuhqkaqedtxuqwhoq";
export const MAX_JSON_BYTES = 1024 * 1024;
export const MAX_OBJECT_BYTES = 32 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
export const MAGIC = Buffer.from("mfmf-storage-backup-v1\n");
const TABLE_BUCKETS = { record_photos: "daycare-photos", profiles: "avatars", households: "avatars", pets: "avatars" };
export const fail = () => { throw new Error("Storage backup failed; details withheld."); };
export const requireValue = (condition) => { if (!condition) fail(); };
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const identity = (bucket, path) => JSON.stringify([bucket, path]);

export function exact(value, keys) {
  requireValue(value && typeof value === "object" && !Array.isArray(value));
  requireValue(Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)));
}

// Canonicalize only bounded JSON, never arbitrary JS objects from the application.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function json(bytes) {
  requireValue(bytes.length <= MAX_JSON_BYTES);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export function frame(value) {
  const bytes = Buffer.from(JSON.stringify(value));
  requireValue(bytes.length > 0 && bytes.length <= MAX_JSON_BYTES);
  const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

export function manifestFor(snapshot, objects = snapshot.objects.map((entry) => ({ bucket: entry.bucket, path: entry.path, size: entry.metadata.size, hashes: {} }))) {
  return { formatVersion: 1, source: objects, destination: [], references: snapshot.references, tombstones: [] };
}

export function validateSnapshot(snapshot) {
  exact(snapshot, ["formatVersion", "readOnly", "bypassRls", "buckets", "objects", "references"]);
  requireValue(snapshot.formatVersion === 1 && snapshot.readOnly === true && snapshot.bypassRls === true);
  requireValue(Array.isArray(snapshot.buckets) && snapshot.buckets.length === 2 && Array.isArray(snapshot.objects));
  requireValue(snapshot.objects.length <= 1000);
  const buckets = new Set();
  for (const bucket of snapshot.buckets) {
    exact(bucket, ["id", "name", "public", "fileSizeLimit", "allowedMimeTypes"]);
    requireValue(Object.values(TABLE_BUCKETS).includes(bucket.id) && bucket.name === bucket.id && bucket.public === false && !buckets.has(bucket.id));
    requireValue(bucket.fileSizeLimit === null || (Number.isSafeInteger(bucket.fileSizeLimit) && bucket.fileSizeLimit >= 0));
    requireValue(bucket.allowedMimeTypes === null || (Array.isArray(bucket.allowedMimeTypes) && bucket.allowedMimeTypes.every((type) => typeof type === "string" && type.length <= 256)));
    buckets.add(bucket.id);
  }
  let bytes = 0;
  for (const object of snapshot.objects) {
    exact(object, ["bucket", "path", "version", "createdAt", "updatedAt", "metadata"]);
    requireValue(object.version === null || (typeof object.version === "string" && object.version.length <= 256));
    requireValue([object.createdAt, object.updatedAt].every((time) => typeof time === "string" && time.length <= 64 && Number.isFinite(Date.parse(time))));
    requireValue(object.metadata && typeof object.metadata === "object" && !Array.isArray(object.metadata));
    requireValue(Number.isSafeInteger(object.metadata.size) && object.metadata.size >= 0 && object.metadata.size <= MAX_OBJECT_BYTES);
    // Preserve provider metadata only inside encryption; no ETag -> MD5 inference.
    requireValue(Buffer.byteLength(JSON.stringify(object.metadata)) <= 8192);
    bytes += object.metadata.size;
  }
  requireValue(bytes <= MAX_TOTAL_BYTES);
  requireValue(Buffer.byteLength(JSON.stringify(snapshot)) <= MAX_JSON_BYTES);
  const manifest = manifestFor(snapshot);
  reconcileStorageManifest(manifest); // strict opaque paths, duplicate rejection and total-entry bound
  // Reserve space for both source and future destination in the offline comparer.
  requireValue(snapshot.objects.length * 2 + Object.values(snapshot.references).reduce((n, list) => n + list.length, 0) <= 5000);
  return snapshot;
}

export function summarize(snapshot) {
  const objects = new Set(snapshot.objects.map((entry) => identity(entry.bucket, entry.path)));
  const refs = new Map();
  let referenceRows = 0;
  for (const [table, paths] of Object.entries(snapshot.references)) {
    for (const path of paths) {
      if (path === null) continue;
      referenceRows++;
      const key = identity(TABLE_BUCKETS[table], path);
      refs.set(key, (refs.get(key) ?? 0) + 1);
    }
  }
  return {
    objects: objects.size, totalBytes: snapshot.objects.reduce((sum, entry) => sum + entry.metadata.size, 0),
    referenceRows, referencedObjects: refs.size,
    unreferencedObjects: [...objects].filter((key) => !refs.has(key)).length,
    missingReferencedObjects: [...refs.keys()].filter((key) => !objects.has(key)).length,
    sharedPaths: [...refs.values()].filter((count) => count > 1).length,
  };
}

// Bounded, framing-aware reader. No extraction to names supplied by the archive.
async function consumeArchive(input, capture) {
  const iterator = input[Symbol.asyncIterator]();
  let pending = Buffer.alloc(0);
  let ended = false;
  const read = async (size) => {
    requireValue(Number.isSafeInteger(size) && size >= 0 && size <= MAX_OBJECT_BYTES);
    const chunks = []; let remaining = size;
    while (remaining) {
      if (!pending.length) {
        const next = await iterator.next();
        if (next.done) { ended = true; fail(); }
        pending = Buffer.from(next.value);
      }
      const take = Math.min(remaining, pending.length);
      chunks.push(pending.subarray(0, take)); pending = pending.subarray(take); remaining -= take;
    }
    return Buffer.concat(chunks, size);
  };
  const readFrame = async () => {
    const size = (await read(4)).readUInt32BE();
    requireValue(size > 0 && size <= MAX_JSON_BYTES);
    return json(await read(size));
  };
  try {
    requireValue((await read(MAGIC.length)).equals(MAGIC));
    const header = await readFrame();
    exact(header, ["kind", "sourceRef", "snapshot"]);
    requireValue(header.kind === "storage-backup" && header.sourceRef === SOURCE_REF);
    const snapshot = validateSnapshot(header.snapshot);
    requireValue(snapshot.objects.length > 0);
    const sources = [];
    const objects = [];
    for (let index = 0; index < snapshot.objects.length; index++) {
      const object = await readFrame();
      exact(object, ["kind", "index", "size", "sha256"]);
      requireValue(object.kind === "object" && object.index === index && object.size === snapshot.objects[index].metadata.size);
      requireValue(typeof object.sha256 === "string" && /^[a-f0-9]{64}$/.test(object.sha256));
      const bytes = await read(object.size);
      requireValue(sha256(bytes) === object.sha256);
      const { bucket, path } = snapshot.objects[index];
      sources.push({ bucket, path, size: object.size, hashes: { sha256: object.sha256 } });
      if (capture) objects.push({ bucket, path, bytes, sha256: object.sha256 });
    }
    const footer = await readFrame();
    exact(footer, ["kind", "manifest", "snapshotSha256", "consistency"]);
    requireValue(footer.kind === "complete" && footer.consistency === "metadata-unchanged-between-reads");
    requireValue(footer.snapshotSha256 === sha256(canonical(snapshot)));
    requireValue(canonical(footer.manifest) === canonical(manifestFor(snapshot, sources)));
    requireValue(!pending.length && (await iterator.next()).done);
    ended = true;
    const summary = { operation: "archive-byte-verification", readiness: "not-assessed", ...summarize(snapshot), verifiedObjects: sources.length };
    return capture ? { snapshot, manifest: footer.manifest, objects, summary } : summary;
  } finally {
    if (!ended && iterator.return) await iterator.return().catch(() => {});
  }
}

export const verifyArchive = (input) => consumeArchive(input, false);
// Private caller memory only, returned after the entire archive/footer/EOF verifies.
// Never log or persist this return value unencrypted.
export const decodeArchiveForOperator = (input) => consumeArchive(input, true);
