#!/usr/bin/env node
// Offline metadata comparison only. No filesystem reads, credentials or SDKs.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_ENTRIES = 5000;
const REFERENCE_BUCKETS = {
  record_photos: "daycare-photos",
  profiles: "avatars",
  households: "avatars",
  pets: "avatars",
};
const HASH_LENGTHS = { sha256: 64, md5: 32, crc32c: 8 };
const INPUT_ERROR = "Invalid manifest; values and diagnostic details withheld.";

function requireCondition(condition) {
  if (!condition) throw new Error(INPUT_ERROR);
}

function record(value, keys) {
  requireCondition(value !== null && typeof value === "object" && !Array.isArray(value));
  requireCondition(Object.getPrototypeOf(value) === Object.prototype);
  requireCondition(Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)));
}

function objectPath(value) {
  // Paths are opaque, case-sensitive object names, including legacy owner paths.
  // Never trim, decode URLs, normalize Unicode or resolve dot segments.
  requireCondition(typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 1024 && !/[\u0000-\u001f\u007f]/.test(value));
}

function objectIdentity(value) {
  requireCondition(value.bucket === "daycare-photos" || value.bucket === "avatars");
  objectPath(value.path);
  return JSON.stringify([value.bucket, value.path]);
}

function validate(manifest) {
  record(manifest, ["formatVersion", "source", "destination", "references", "tombstones"]);
  requireCondition(manifest.formatVersion === 1);
  record(manifest.references, Object.keys(REFERENCE_BUCKETS));
  const lists = [manifest.source, manifest.destination, manifest.tombstones, ...Object.values(manifest.references)];
  requireCondition(lists.every(Array.isArray));
  requireCondition(lists.reduce((count, list) => count + list.length, 0) <= MAX_ENTRIES);

  for (const list of [manifest.source, manifest.destination, manifest.tombstones]) {
    const seen = new Set();
    for (const entry of list) {
      const tombstones = list === manifest.tombstones;
      record(entry, tombstones ? ["bucket", "path"] : ["bucket", "path", "size", "hashes"]);
      const key = objectIdentity(entry);
      requireCondition(!seen.has(key));
      seen.add(key);
      if (tombstones) continue;
      requireCondition(entry.size === null || (Number.isSafeInteger(entry.size) && entry.size >= 0));
      requireCondition(entry.hashes !== null && typeof entry.hashes === "object" && !Array.isArray(entry.hashes));
      requireCondition(Object.getPrototypeOf(entry.hashes) === Object.prototype);
      for (const [algorithm, hash] of Object.entries(entry.hashes)) {
        requireCondition(Object.hasOwn(HASH_LENGTHS, algorithm));
        requireCondition(typeof hash === "string" && hash.length === HASH_LENGTHS[algorithm] && /^[a-f0-9]+$/i.test(hash));
      }
    }
  }
  for (const [table, paths] of Object.entries(manifest.references)) {
    for (const path of paths) {
      if (path === null && table !== "record_photos") continue;
      objectPath(path);
    }
  }
}

const location = (collection, index) => ({ collection, index });

export function reconcileStorageManifest(manifest) {
  validate(manifest);
  const source = new Map(manifest.source.map((entry, index) => [objectIdentity(entry), { entry, index }]));
  const destination = new Map(manifest.destination.map((entry, index) => [objectIdentity(entry), { entry, index }]));
  const deleted = new Map(manifest.tombstones.map((entry, index) => [objectIdentity(entry), index]));
  const referenced = new Set();
  const findings = [];
  let matchingPairs = 0;
  let unsetAvatars = 0;
  const add = (category, at, related, detail) => {
    // Only fixed vocabulary and array offsets leave this function. Never return
    // input objects, paths, sizes, digests, arbitrary keys or exception messages.
    findings.push({ category, at, ...(related ? { related } : {}), ...(detail ? { detail } : {}) });
  };

  for (const [table, paths] of Object.entries(manifest.references)) {
    paths.forEach((path, index) => {
      if (path === null) { unsetAvatars++; return; }
      const key = JSON.stringify([REFERENCE_BUCKETS[table], path]);
      referenced.add(key);
      const at = { collection: "references", table, index };
      if (!source.has(key)) add("referenced-source-missing", at);
      if (!destination.has(key)) add("referenced-destination-missing", at);
      if (deleted.has(key)) add("tombstone-reference", at, location("tombstones", deleted.get(key)));
    });
  }

  for (const [key, { entry, index }] of source) {
    const at = location("source", index);
    if (deleted.has(key)) {
      add("tombstone-source-present", at, location("tombstones", deleted.get(key)));
      continue; // A tombstone is never interpreted as permission to copy/delete.
    }
    if (!referenced.has(key)) add("source-unreferenced", at);
    const target = destination.get(key);
    if (!target) { add("destination-missing", at); continue; }
    const related = location("destination", target.index);
    let matched = true;
    if (entry.size === null || target.entry.size === null) {
      add("comparison-inconclusive", at, related, "missing-size");
      matched = false;
    } else if (entry.size !== target.entry.size) {
      add("size-mismatch", at, related);
      matched = false;
    }
    const common = Object.keys(HASH_LENGTHS).filter((algorithm) => Object.hasOwn(entry.hashes, algorithm) && Object.hasOwn(target.entry.hashes, algorithm));
    if (!common.length) {
      add("comparison-inconclusive", at, related, "no-common-hash");
      matched = false;
    } else if (common.some((algorithm) => entry.hashes[algorithm].toLowerCase() !== target.entry.hashes[algorithm].toLowerCase())) {
      add("hash-mismatch", at, related);
      matched = false;
    }
    if (matched) matchingPairs++;
  }

  for (const [key, { index }] of destination) {
    const at = location("destination", index);
    if (deleted.has(key)) {
      add("tombstone-destination-present", at, location("tombstones", deleted.get(key)));
      continue;
    }
    if (!source.has(key)) add("destination-only", at);
    if (!referenced.has(key)) add("destination-unreferenced", at);
  }
  for (const [key, index] of deleted) {
    if (!source.has(key) && !destination.has(key) && !referenced.has(key)) add("tombstone-absent", location("tombstones", index));
  }

  const issues = findings.filter((finding) => finding.category !== "tombstone-absent");
  const comparison = issues.some((finding) => finding.category !== "comparison-inconclusive") ? "differences"
    : issues.length ? "inconclusive" : matchingPairs ? "matched" : "empty";
  return {
    formatVersion: 1,
    kind: "offline-storage-metadata-comparison",
    readiness: "not-assessed",
    comparison,
    summary: {
      sourceObjects: source.size, destinationObjects: destination.size,
      referencedObjects: referenced.size, unsetAvatars, tombstones: deleted.size, matchingPairs,
      findingsByCategory: Object.fromEntries([...new Set(findings.map((finding) => finding.category))].sort().map((category) => [category, findings.filter((finding) => finding.category === category).length])),
    },
    findings,
  };
}

function readInput(input) {
  return new Promise((resolveInput, reject) => {
    const chunks = [];
    let bytes = 0;
    const finish = (error) => {
      clearTimeout(timer);
      input.off("data", onData); input.off("end", onEnd); input.off("error", onError);
      input.pause();
      if (error) reject(error);
      else resolveInput(Buffer.concat(chunks));
    };
    const onData = (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_INPUT_BYTES) finish(new Error(INPUT_ERROR));
      else chunks.push(chunk);
    };
    const onEnd = () => finish();
    const onError = () => finish(new Error(INPUT_ERROR));
    const timer = setTimeout(() => finish(new Error(INPUT_ERROR)), 10000);
    input.on("data", onData); input.once("end", onEnd); input.once("error", onError);
  });
}

const write = (stream, text) => new Promise((resolveWrite, reject) => stream.write(text, (error) => error ? reject(error) : resolveWrite()));

export async function main(args = process.argv.slice(2), input = process.stdin, output = process.stdout, errorOutput = process.stderr) {
  try {
    if (args.length || input.isTTY) {
      await write(errorOutput, "Usage: node scripts/gcp/reconcile-storage-manifest.mjs < synthetic-manifest.json\n");
      return 1;
    }
    const bytes = await readInput(input);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const result = reconcileStorageManifest(JSON.parse(text));
    await write(output, `${JSON.stringify(result, null, 2)}\n`);
    return result.comparison === "matched" ? 0 : 2;
  } catch {
    try { await write(errorOutput, `${INPUT_ERROR}\n`); } catch { /* Broken pipes must not print exception details. */ }
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.stdout.on("error", () => { process.exitCode = 1; });
  process.stderr.on("error", () => { process.exitCode = 1; });
  process.exitCode = await main();
}
