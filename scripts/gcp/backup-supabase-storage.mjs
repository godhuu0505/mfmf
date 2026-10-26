#!/usr/bin/env node
// Operator only: never imported by src/. Privileged Storage key stays in memory.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, open, rename, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { SOURCE_REF, MAX_JSON_BYTES, MAX_OBJECT_BYTES, MAGIC, requireValue, fail, json, frame, canonical, sha256, manifestFor, validateSnapshot, summarize } from "./storage-backup-format.mjs";

const SOURCE_ORIGIN = `https://${SOURCE_REF}.supabase.co`;
const MANAGEMENT = `https://api.supabase.com/v1/projects/${SOURCE_REF}`;
const OUTPUT_DIRECTORY = "storage-backup-encrypted";
const OUTPUT_FILE = "storage-objects.mfmf.age";
const ERROR = "Storage backup failed; details withheld. No completed backup was published.\n";

// A single statement has one MVCC snapshot. Bounds include an overflow sentinel;
// validation rejects it instead of silently accepting a truncated inventory.
export const INVENTORY_SQL = `SELECT jsonb_build_object(
  'formatVersion', 1,
  'readOnly', current_setting('transaction_read_only') = 'on',
  'bypassRls', EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)),
  'buckets', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'name', name, 'public', public,
    'fileSizeLimit', file_size_limit, 'allowedMimeTypes', allowed_mime_types) ORDER BY id)
    FROM storage.buckets WHERE id IN ('daycare-photos', 'avatars')), '[]'::jsonb),
  'objects', COALESCE((SELECT jsonb_agg(jsonb_build_object('bucket', bucket_id, 'path', name,
    'version', version, 'createdAt', created_at, 'updatedAt', updated_at, 'metadata', metadata) ORDER BY bucket_id, name)
    FROM (SELECT bucket_id, name, version, created_at, updated_at, metadata FROM storage.objects
      WHERE bucket_id IN ('daycare-photos', 'avatars') ORDER BY bucket_id, name LIMIT 1001) AS bounded_objects), '[]'::jsonb),
  'references', jsonb_build_object(
    'record_photos', COALESCE((SELECT jsonb_agg(storage_path ORDER BY storage_path, id) FROM
      (SELECT id, storage_path FROM public.record_photos ORDER BY storage_path, id LIMIT 5001) AS bounded_photos), '[]'::jsonb),
    'profiles', COALESCE((SELECT jsonb_agg(avatar_path ORDER BY avatar_path NULLS FIRST, owner_id) FROM
      (SELECT owner_id, avatar_path FROM public.profiles ORDER BY avatar_path NULLS FIRST, owner_id LIMIT 5001) AS bounded_profiles), '[]'::jsonb),
    'households', COALESCE((SELECT jsonb_agg(avatar_path ORDER BY avatar_path NULLS FIRST, id) FROM
      (SELECT id, avatar_path FROM public.households ORDER BY avatar_path NULLS FIRST, id LIMIT 5001) AS bounded_households), '[]'::jsonb),
    'pets', COALESCE((SELECT jsonb_agg(avatar_path ORDER BY avatar_path NULLS FIRST, id) FROM
      (SELECT id, avatar_path FROM public.pets ORDER BY avatar_path NULLS FIRST, id LIMIT 5001) AS bounded_pets), '[]'::jsonb)
  )
) AS snapshot`;

async function boundedBody(response, limit) {
  const reader = response.body?.getReader();
  requireValue(reader);
  const chunks = []; let size = 0; let done = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) { done = true; break; }
      size += next.value.byteLength;
      requireValue(size <= limit);
      chunks.push(next.value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function request(fetchImpl, url, options, signal) {
  const response = await fetchImpl(url, { ...options, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) });
  if (response.status !== 200 && !(options.method === "POST" && response.status === 201)) {
    await response.body?.cancel().catch(() => {});
    fail(); // Error bodies, URLs, headers and exception messages never leave this process.
  }
  return response;
}

function validateEnvironment(env) {
  requireValue(env.GITHUB_ACTIONS === "true" && env.GITHUB_REPOSITORY === "godhuu0505/mfmf" && env.GITHUB_REF === "refs/heads/main" && env.GITHUB_EVENT_NAME === "workflow_dispatch");
  requireValue(env.SUPABASE_PROJECT_ID === SOURCE_REF);
  requireValue(typeof env.SUPABASE_ACCESS_TOKEN === "string" && env.SUPABASE_ACCESS_TOKEN.length > 0 && env.SUPABASE_ACCESS_TOKEN.length <= 16384 && !/[\r\n]/.test(env.SUPABASE_ACCESS_TOKEN));
}

export function objectUrl(object) {
  requireValue(object.bucket === "daycare-photos" || object.bucket === "avatars");
  // These names are not normalized. Ambiguous HTTP path forms fail closed and
  // need a separate addressing review; they are still legal in offline manifests.
  requireValue(typeof object.path === "string" && !object.path.includes("\\") && object.path.split("/").every((part) => part && part !== "." && part !== ".."));
  const raw = `${SOURCE_ORIGIN}/storage/v1/object/${object.bucket}/${object.path.split("/").map(encodeURIComponent).join("/")}`;
  const parsed = new URL(raw);
  requireValue(parsed.origin === SOURCE_ORIGIN && parsed.href === raw && !parsed.search && !parsed.hash);
  return raw;
}

export async function inventory({ env, fetchImpl = fetch, signal = AbortSignal.timeout(20 * 60_000) }) {
  validateEnvironment(env);
  const response = await request(fetchImpl, `${MANAGEMENT}/database/query`, {
    method: "POST", headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: INVENTORY_SQL, read_only: true }),
  }, signal);
  const result = json(await boundedBody(response, MAX_JSON_BYTES));
  requireValue(Array.isArray(result) && result.length === 1 && Object.keys(result[0]).length === 1 && Object.hasOwn(result[0], "snapshot"));
  return validateSnapshot(result[0].snapshot);
}

export async function storageKey({ env, fetchImpl, signal }) {
  const response = await request(fetchImpl, `${MANAGEMENT}/api-keys?reveal=true`, {
    method: "GET", headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` },
  }, signal);
  const keys = json(await boundedBody(response, 64 * 1024));
  requireValue(Array.isArray(keys) && keys.length <= 100);
  // Deliberately support the documented legacy project key only. Do not choose
  // an arbitrary new secret key or silently create/rotate any credential.
  const matches = keys.filter((key) => key?.name === "service_role" && (key.type === "legacy" || key.type == null));
  requireValue(matches.length === 1);
  const key = matches[0].api_key;
  requireValue(typeof key === "string" && key.length <= 16384 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key));
  const claims = json(Buffer.from(key.split(".")[1], "base64url"));
  requireValue(claims.role === "service_role" && claims.ref === SOURCE_REF && Number.isSafeInteger(claims.exp) && claims.exp > Date.now() / 1000);
  return key; // Never passed to child-process env, argv, logs, files or archive.
}

export async function* backupArchive({ env, fetchImpl = fetch, signal = AbortSignal.timeout(20 * 60_000) }) {
  const snapshot = await inventory({ env, fetchImpl, signal });
  requireValue(snapshot.objects.length > 0);
  snapshot.objects.forEach(objectUrl); // Validate every address before acquiring a privileged key.
  let key = await storageKey({ env, fetchImpl, signal });
  const sources = [];
  try {
    yield MAGIC;
    yield frame({ kind: "storage-backup", sourceRef: SOURCE_REF, snapshot });
    for (let index = 0; index < snapshot.objects.length; index++) {
      const object = snapshot.objects[index];
      const response = await request(fetchImpl, objectUrl(object), {
        method: "GET", headers: { apikey: key, Authorization: `Bearer ${key}`, "Accept-Encoding": "identity", "Cache-Control": "no-cache" },
      }, signal);
      if (response.headers.get("content-encoding") && response.headers.get("content-encoding") !== "identity") {
        await response.body?.cancel().catch(() => {});
        fail();
      }
      const bytes = await boundedBody(response, Math.min(MAX_OBJECT_BYTES, object.metadata.size));
      requireValue(bytes.length === object.metadata.size);
      const hash = sha256(bytes);
      sources.push({ bucket: object.bucket, path: object.path, size: bytes.length, hashes: { sha256: hash } });
      yield frame({ kind: "object", index, size: bytes.length, sha256: hash });
      yield bytes;
    }
  } finally { key = undefined; }
  // GET access time is deliberately excluded: reads can change last_accessed_at.
  const after = await inventory({ env, fetchImpl, signal });
  requireValue(canonical(snapshot) === canonical(after));
  yield frame({ kind: "complete", manifest: manifestFor(snapshot, sources), snapshotSha256: sha256(canonical(snapshot)), consistency: "metadata-unchanged-between-reads" });
}

function ageProcess(recipient, outputFd) {
  return spawn("/usr/bin/age", ["--encrypt", "--recipient", recipient], {
    stdio: ["pipe", outputFd ?? "ignore", "ignore"], env: { PATH: "/usr/bin:/bin", LANG: "C" },
  });
}

async function encrypt(child, input, signal) {
  const completion = new Promise((resolveChild, rejectChild) => {
    child.once("error", rejectChild);
    child.once("close", (code) => code === 0 ? resolveChild() : rejectChild(new Error("Encryption failed")));
  });
  try { await Promise.all([pipeline(Readable.from(input), child.stdin, { signal }), completion]); }
  finally { if (child.exitCode === null) child.kill("SIGKILL"); }
}

export async function runBackup({ env, fetchImpl = fetch, signal = AbortSignal.timeout(20 * 60_000), spawnAge = ageProcess }) {
  validateEnvironment(env);
  const recipient = env.SUPABASE_BACKUP_AGE_RECIPIENT;
  requireValue(typeof recipient === "string" && /^age1[a-z0-9]{58}$/.test(recipient));
  const directory = env.RUNNER_TEMP;
  requireValue(typeof directory === "string" && isAbsolute(directory) && directory !== "/" && directory !== tmpdir());
  const stat = await lstat(directory); requireValue(stat.isDirectory() && !stat.isSymbolicLink());
  const finalDirectory = join(directory, OUTPUT_DIRECTORY);
  try { await lstat(finalDirectory); fail(); } catch (error) { if (error.code !== "ENOENT") throw error; }
  // Verify the public age recipient before obtaining any remote data or key.
  await encrypt(spawnAge(recipient), [], signal);
  const work = await mkdtemp(join(directory, "storage-backup-private-"));
  let output;
  let published = false;
  let finalCreated = false;
  try {
    output = await open(join(work, OUTPUT_FILE), "wx", 0o600);
    let summary;
    async function* archive() {
      let first = true;
      for await (const chunk of backupArchive({ env, fetchImpl, signal })) {
        if (first) first = false;
        else if (!summary) summary = summarize(json(chunk.subarray(4)).snapshot);
        yield chunk;
      }
    }
    await encrypt(spawnAge(recipient, output.fd), archive(), signal);
    await output.close(); output = undefined;
    await mkdir(finalDirectory, { mode: 0o700 });
    finalCreated = true;
    await rename(join(work, OUTPUT_FILE), join(finalDirectory, OUTPUT_FILE));
    published = true;
    return { operation: "encrypted-storage-backup", consistency: "metadata-unchanged-between-reads", readiness: "not-assessed", ...summary };
  } finally {
    await output?.close().catch(() => {});
    await rm(work, { recursive: true, force: true });
    if (finalCreated && !published) await rm(finalDirectory, { recursive: true, force: true });
  }
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  try {
    requireValue(args.length === 0 || (args.length === 1 && args[0] === "--inventory"));
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20 * 60_000)]);
    let result;
    if (args.length) {
      const before = await inventory({ env, signal });
      const after = await inventory({ env, signal });
      requireValue(canonical(before) === canonical(after));
      result = { operation: "storage-inventory", readiness: "not-assessed", ...summarize(before) };
    } else result = await runBackup({ env, signal });
    await new Promise((resolveWrite, reject) => process.stdout.write(`${JSON.stringify(result)}\n`, (error) => error ? reject(error) : resolveWrite()));
    return 0;
  } catch {
    try { await new Promise((resolveWrite) => process.stderr.write(ERROR, resolveWrite)); } catch { /* no diagnostics */ }
    return 1;
  } finally { process.off("SIGTERM", stop); process.off("SIGINT", stop); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.stdout.on("error", () => { process.exitCode = 1; });
  process.stderr.on("error", () => { process.exitCode = 1; });
  process.exitCode = await main();
}
