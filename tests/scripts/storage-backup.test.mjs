import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir, writeFile, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { backupArchive, runBackup, inventory, INVENTORY_SQL, objectUrl } from "../../scripts/gcp/backup-supabase-storage.mjs";
import { SOURCE_REF, MAX_OBJECT_BYTES, MAX_TOTAL_BYTES, MAGIC, frame, canonical, sha256, manifestFor, validateSnapshot, summarize, verifyArchive } from "../../scripts/gcp/storage-backup-format.mjs";
import { main as verifyMain } from "../../scripts/gcp/verify-storage-backup.mjs";

const PRIVATE = "PRIVATE_FIXTURE_DO_NOT_PRINT";
const body = Buffer.from(`synthetic image bytes ${PRIVATE}`);
const env = {
  GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "godhuu0505/mfmf", GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "workflow_dispatch",
  SUPABASE_PROJECT_ID: SOURCE_REF, SUPABASE_ACCESS_TOKEN: `fixture-pat-${PRIVATE}`,
};
const jwt = `fixture.${Buffer.from(JSON.stringify({ role: "service_role", ref: SOURCE_REF, exp: 4102444800 })).toString("base64url")}.signature`;
const snapshot = () => ({
  formatVersion: 1, readOnly: true, bypassRls: true,
  buckets: ["avatars", "daycare-photos"].map((id) => ({ id, name: id, public: false, fileSizeLimit: null, allowedMimeTypes: ["image/jpeg"] })),
  objects: [{ bucket: "daycare-photos", path: `legacy-owner/record/${PRIVATE}雪%.jpg`, version: "fixture-version", createdAt: "2026-10-27T00:00:00Z", updatedAt: "2026-10-27T00:00:00Z", metadata: { size: body.length, mimetype: "image/jpeg", cacheControl: "3600", eTag: `not-a-hash-${PRIVATE}` } }],
  references: { record_photos: [`legacy-owner/record/${PRIVATE}雪%.jpg`], profiles: [null], households: [null], pets: [null] },
});
function fakeFetch({ before = snapshot(), after = before, keys = [{ name: "service_role", type: "legacy", api_key: jwt }], bytes = body, failure, encoding } = {}) {
  const calls = []; let reads = 0;
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    if (failure) return new Response(PRIVATE, { status: failure });
    if (url.endsWith("/database/query")) {
      assert.equal(url, `https://api.supabase.com/v1/projects/${SOURCE_REF}/database/query`);
      assert.equal(options.method, "POST");
      assert.deepEqual(JSON.parse(options.body), { query: INVENTORY_SQL, read_only: true });
      assert.equal(options.headers.Authorization, `Bearer ${env.SUPABASE_ACCESS_TOKEN}`);
      return Response.json([{ snapshot: reads++ ? after : before }]);
    }
    if (url.endsWith("/api-keys?reveal=true")) {
      assert.equal(options.method, "GET");
      return Response.json(keys);
    }
    assert.equal(url, objectUrl(before.objects[calls.filter((call) => call.url.includes("/storage/v1/")).length - 1]));
    assert.equal(options.method, "GET");
    assert.equal(options.headers.apikey, jwt);
    assert.equal(options.headers.Authorization, `Bearer ${jwt}`);
    assert.equal(options.headers["Accept-Encoding"], "identity");
    return new Response(bytes, { headers: encoding ? { "Content-Encoding": encoding } : {} });
  };
  return { fetchImpl, calls };
}
async function collect(options = {}) {
  const fake = fakeFetch(options); const chunks = [];
  for await (const chunk of backupArchive({ env, fetchImpl: fake.fetchImpl })) chunks.push(chunk);
  return { bytes: Buffer.concat(chunks), ...fake };
}
const verify = (bytes) => verifyArchive(Readable.from([bytes]));

test("fixed SQL is one read-only SELECT, all sources bounded, no app text/identity columns", () => {
  assert.match(INVENTORY_SQL, /^SELECT /);
  assert.doesNotMatch(INVENTORY_SQL, /;|\b(INSERT|UPDATE|DELETE|COPY|ALTER|DROP|email|content)\b/i);
  assert.match(INVENTORY_SQL, /SELECT owner_id, avatar_path FROM public\.profiles/);
  assert.doesNotMatch(INVENTORY_SQL, /'owner_id'/); // sort key is never part of the returned JSON
  for (const table of ["record_photos", "profiles", "households", "pets"]) assert.match(INVENTORY_SQL, new RegExp(`public\\.${table}`));
  assert.equal((INVENTORY_SQL.match(/LIMIT 5001/g) ?? []).length, 4);
  assert.match(INVENTORY_SQL, /LIMIT 1001/);
  assert.doesNotMatch(INVENTORY_SQL, /last_accessed_at/);
});

test("backup uses exact management endpoints and GET-only Storage; byte verification round trip", async () => {
  const { bytes, calls } = await collect();
  assert.equal(calls.length, 4);
  assert.equal(calls.filter((call) => call.url.endsWith("/database/query")).length, 2);
  assert.equal(bytes.includes(Buffer.from(jwt)), false);
  assert.equal(bytes.includes(Buffer.from(env.SUPABASE_ACCESS_TOKEN)), false);
  assert.ok(bytes.includes(body)); // plaintext only in the in-memory archive fixture
  const result = await verify(bytes);
  assert.equal(result.verifiedObjects, 1);
  assert.equal(result.readiness, "not-assessed");
  assert.equal(result.totalBytes, body.length);
  assert.equal(JSON.stringify(result).includes(PRIVATE), false);
  // Verify across arbitrary stream boundaries too.
  assert.deepEqual(await verifyArchive(Readable.from([...bytes].map((byte) => Buffer.from([byte])))), result);
});

test("inventory obtains no Storage key or object body", async () => {
  const fake = fakeFetch();
  const result = await inventory({ env, fetchImpl: fake.fetchImpl });
  assert.deepEqual(result, snapshot());
  assert.equal(fake.calls.length, 1);
});

test("both buckets and all four reference sources survive the encrypted archive shape", async () => {
  const before = snapshot();
  before.objects.push({ ...before.objects[0], bucket: "avatars", path: `profile/${PRIVATE}.jpg` });
  for (const table of ["profiles", "households", "pets"]) before.references[table] = [before.objects[1].path];
  const result = await verify((await collect({ before })).bytes);
  assert.equal(result.verifiedObjects, 2);
  assert.equal(result.referenceRows, 4);
  assert.equal(result.sharedPaths, 1);
  assert.equal(result.missingReferencedObjects, 0);
  assert.equal(result.unreferencedObjects, 0);
});

test("wrong project/repo/event/ref/token are rejected before any fetch", async () => {
  for (const change of [{ SUPABASE_PROJECT_ID: "abcdefghijklmnopqrst" }, { GITHUB_REPOSITORY: "attacker/fork" }, { GITHUB_REF: "refs/heads/feature" }, { GITHUB_EVENT_NAME: "pull_request" }, { GITHUB_ACTIONS: "false" }, { SUPABASE_ACCESS_TOKEN: "x\r\ny" }]) {
    const fake = fakeFetch();
    await assert.rejects(inventory({ env: { ...env, ...change }, fetchImpl: fake.fetchImpl }));
    assert.equal(fake.calls.length, 0);
  }
});

test("read-only transaction, bypass visibility, private bucket and exact fixed shape are mandatory", () => {
  for (const mutate of [
    (s) => { s.readOnly = false; }, (s) => { s.bypassRls = false; }, (s) => { s.buckets[0].public = true; },
    (s) => { s.buckets.pop(); }, (s) => { s.buckets[0].id = "other"; }, (s) => { s.extra = PRIVATE; },
    (s) => { s.objects[0].metadata.size = null; }, (s) => { s.objects[0].metadata.size = MAX_OBJECT_BYTES + 1; },
    (s) => { s.objects[0].metadata.size = -1; }, (s) => { s.objects[0].path = ""; },
    (s) => { s.objects.push(structuredClone(s.objects[0])); }, (s) => { s.references.profiles[0] = ""; },
    (s) => { s.references.record_photos = [null]; },
  ]) { const data = snapshot(); mutate(data); assert.throws(() => validateSnapshot(data)); }
});

test("entry, total-byte, metadata-byte and comparer capacity bounds fail closed", () => {
  const makeObjects = (n, size) => Array.from({ length: n }, (_, i) => ({ ...snapshot().objects[0], path: `fixture/${i}`, metadata: { size } }));
  for (const data of [
    { ...snapshot(), objects: makeObjects(1001, 0) },
    { ...snapshot(), objects: makeObjects(9, MAX_OBJECT_BYTES) },
    { ...snapshot(), references: { ...snapshot().references, record_photos: Array(5000).fill("fixture") } },
    { ...snapshot(), objects: [{ ...snapshot().objects[0], metadata: { size: 1, other: PRIVATE.repeat(1000) } }] },
  ]) assert.throws(() => validateSnapshot(data));
  assert.equal(MAX_TOTAL_BYTES, 8 * MAX_OBJECT_BYTES);
});

test("summaries distinguish missing, unreferenced, shared and null avatars without values", () => {
  const data = snapshot();
  data.references.record_photos.push(data.references.record_photos[0], "missing-fixture");
  data.objects.push({ ...data.objects[0], bucket: "avatars", path: "orphan-fixture" });
  const result = summarize(validateSnapshot(data));
  assert.equal(result.missingReferencedObjects, 1);
  assert.equal(result.unreferencedObjects, 1);
  assert.equal(result.sharedPaths, 1);
  assert.equal(JSON.stringify(result).includes(PRIVATE), false);
});

test("legacy/Unicode/percent paths preserve identities; ambiguous HTTP dot/empty/backslash paths are refused", () => {
  assert.ok(objectUrl(snapshot().objects[0]).includes("%E9%9B%AA%25.jpg"));
  assert.ok(objectUrl({ bucket: "avatars", path: "x/%2e%2e/y" }).endsWith("x/%252e%252e/y"));
  for (const path of ["x/../y", "./x", "/x", "x/", "x//y", "x\\y"]) assert.throws(() => objectUrl({ bucket: "avatars", path }));
  assert.throws(() => objectUrl({ bucket: "other", path: "x" }));
});

test("empty sources and unusable addressing fail before retrieving a privileged key", async () => {
  for (const before of [{ ...snapshot(), objects: [] }, { ...snapshot(), objects: [{ ...snapshot().objects[0], path: "x/../y" }] }]) {
    const fake = fakeFetch({ before });
    await assert.rejects(async () => { for await (const chunk of backupArchive({ env, fetchImpl: fake.fetchImpl })) void chunk; });
    assert.equal(fake.calls.length, 1);
  }
});

test("key mismatch/ambiguity/new-secret-only cannot reach Storage", async () => {
  for (const keys of [[], [{ name: "service_role", api_key: PRIVATE }], [{ name: "anon", api_key: jwt }], [{ name: "service_role", type: "secret", api_key: jwt }], [{ name: "service_role", api_key: jwt }, { name: "service_role", api_key: jwt }]]) {
    const fake = fakeFetch({ keys });
    await assert.rejects(async () => { for await (const chunk of backupArchive({ env, fetchImpl: fake.fetchImpl })) void chunk; });
    assert.equal(fake.calls.length, 2);
  }
});

test("source metadata/reference drift, short/long body and compression never yield complete archive", async () => {
  for (const mutate of [(s) => { s.objects[0].version = "changed"; }, (s) => { s.references.pets = ["changed"]; }, (s) => { s.objects[0].metadata.eTag = "changed"; }]) {
    const after = snapshot(); mutate(after);
    await assert.rejects(collect({ after }));
  }
  await assert.rejects(collect({ bytes: body.subarray(1) }));
  await assert.rejects(collect({ bytes: Buffer.concat([body, Buffer.from("x")]) }));
  await assert.rejects(collect({ encoding: "gzip" }));
});

test("error HTTP body is cancelled without reading and raw network errors do not reach CLI output", async () => {
  let cancelled = false;
  await assert.rejects(inventory({ env, fetchImpl: async () => ({ status: 403, body: { cancel: async () => { cancelled = true; }, getReader: () => { throw Error(PRIVATE); } } }) }));
  assert.equal(cancelled, true);
  const child = spawn(process.execPath, ["scripts/gcp/backup-supabase-storage.mjs"], { env: { PATH: process.env.PATH, SUPABASE_ACCESS_TOKEN: PRIVATE, SUPABASE_PROJECT_ID: PRIVATE }, stdio: ["ignore", "pipe", "pipe"] });
  let text = ""; child.stdout.on("data", (b) => { text += b; }); child.stderr.on("data", (b) => { text += b; });
  const code = await new Promise((done) => child.on("close", done));
  assert.equal(code, 1); assert.equal(text.includes(PRIVATE), false); assert.match(text, /^Storage backup failed;/);
});

test("malformed/oversized JSON and response stream errors cannot yield an inventory", async () => {
  for (const makeResponse of [
    () => new Response(PRIVATE), () => new Response(Buffer.from([255])),
    () => new Response(" ".repeat(1024 * 1024 + 1)),
    () => Response.json([{ snapshot: snapshot() }, { snapshot: snapshot() }]),
    () => new Response(new ReadableStream({ start(controller) { controller.error(Error(PRIVATE)); } })),
  ]) await assert.rejects(inventory({ env, fetchImpl: async () => makeResponse() }));
});

test("binary body tampering, truncation, appended data and malformed framing are rejected", async () => {
  const { bytes } = await collect();
  const corrupt = Buffer.from(bytes); corrupt[corrupt.indexOf(body)] ^= 1;
  for (const invalid of [corrupt, bytes.subarray(0, bytes.length - 1), Buffer.concat([bytes, Buffer.from("x")]), Buffer.from(PRIVATE), Buffer.concat([MAGIC, Buffer.from([255, 255, 255, 255])])]) await assert.rejects(verify(invalid));
});

test("footer manifest, SHA256, completeness and object ordering are independently verified", async () => {
  const s = snapshot(); const hash = sha256(body);
  const object = { kind: "object", index: 0, size: body.length, sha256: hash };
  const footer = { kind: "complete", manifest: manifestFor(s, [{ bucket: s.objects[0].bucket, path: s.objects[0].path, size: body.length, hashes: { sha256: hash } }]), snapshotSha256: sha256(canonical(s)), consistency: "metadata-unchanged-between-reads" };
  const pack = (obj, foot) => Buffer.concat([MAGIC, frame({ kind: "storage-backup", sourceRef: SOURCE_REF, snapshot: s }), frame(obj), body, frame(foot)]);
  await verify(pack(object, footer));
  for (const bad of [{ ...footer, snapshotSha256: "0".repeat(64) }, { ...footer, consistency: "ready" }, { ...footer, manifest: manifestFor(s) }]) await assert.rejects(verify(pack(object, bad)));
  await assert.rejects(verify(pack({ ...object, index: 1 }, footer)));
});

test("verification CLI masks malformed bytes, stream errors and broken stdout", async () => {
  for (const input of [Readable.from([Buffer.from([255])]), Readable.from((async function* () { throw Error(PRIVATE); })())]) {
    let diagnostics = "";
    const errors = new Writable({ write(chunk, _, done) { diagnostics += chunk; done(); } });
    assert.equal(await verifyMain([], input, new Writable({ write(_, __, done) { done(); } }), errors), 1);
    assert.equal(diagnostics, "Storage archive verification failed; details withheld.\n");
  }
  const { bytes } = await collect();
  const broken = new Writable({ write(_, __, done) { done(Error(PRIVATE)); } }); broken.on("error", () => {});
  let diagnostics = "";
  assert.equal(await verifyMain([], Readable.from([bytes]), broken, new Writable({ write(chunk, _, done) { diagnostics += chunk; done(); } })), 1);
  assert.equal(diagnostics.includes(PRIVATE), false);
});

const age = ["/usr/bin/age", "/opt/homebrew/bin/age"].find(existsSync);
test("real age round trip publishes only ciphertext, verifies every byte, excludes keys and child env", { skip: !age }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "mfmf-storage-test-"));
  try {
    const keygen = age.replace(/age$/, "age-keygen");
    const identity = execFileSync(keygen, [], { stdio: ["ignore", "pipe", "ignore"] });
    const recipient = execFileSync(keygen, ["-y"], { input: identity, stdio: ["pipe", "pipe", "ignore"] }).toString().trim();
    const identityPath = join(dir, "synthetic-identity"); await writeFile(identityPath, identity, { mode: 0o600 });
    const spawnAge = (value, fd) => spawn(age, ["--encrypt", "--recipient", value], { stdio: ["pipe", fd ?? "ignore", "ignore"], env: { PATH: "/usr/bin:/bin", LANG: "C" } });
    const fake = fakeFetch();
    const result = await runBackup({ env: { ...env, RUNNER_TEMP: dir, SUPABASE_BACKUP_AGE_RECIPIENT: recipient }, fetchImpl: fake.fetchImpl, spawnAge });
    const cipherPath = join(dir, "storage-backup-encrypted", "storage-objects.mfmf.age");
    const cipher = await readFile(cipherPath);
    assert.equal(cipher.includes(body), false); assert.equal(cipher.includes(Buffer.from(jwt)), false); assert.equal(cipher.includes(Buffer.from(env.SUPABASE_ACCESS_TOKEN)), false);
    assert.equal((await stat(cipherPath)).mode & 0o777, 0o600);
    assert.deepEqual((await readdir(dir)).sort(), ["storage-backup-encrypted", "synthetic-identity"]);
    const plaintext = execFileSync(age, ["--decrypt", "--identity", identityPath, cipherPath], { stdio: ["ignore", "pipe", "ignore"] });
    assert.equal((await verify(plaintext)).verifiedObjects, 1);
    assert.equal(JSON.stringify(result).includes(PRIVATE), false);
    await assert.rejects(runBackup({ env: { ...env, RUNNER_TEMP: dir, SUPABASE_BACKUP_AGE_RECIPIENT: recipient }, fetchImpl: async () => assert.fail("must not fetch"), spawnAge }));
    assert.deepEqual(await readFile(cipherPath), cipher);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("encryption/source failure leaves no completed artifact or plaintext file", { skip: !age }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "mfmf-storage-test-"));
  try {
    const keygen = age.replace(/age$/, "age-keygen");
    const identity = execFileSync(keygen, [], { stdio: ["ignore", "pipe", "ignore"] });
    const recipient = execFileSync(keygen, ["-y"], { input: identity, stdio: ["pipe", "pipe", "ignore"] }).toString().trim();
    const spawnAge = (value, fd) => spawn(age, ["--encrypt", "--recipient", value], { stdio: ["pipe", fd ?? "ignore", "ignore"], env: { PATH: "/usr/bin:/bin" } });
    const fake = fakeFetch({ after: { ...snapshot(), references: { ...snapshot().references, pets: ["drift"] } } });
    await assert.rejects(runBackup({ env: { ...env, RUNNER_TEMP: dir, SUPABASE_BACKUP_AGE_RECIPIENT: recipient }, fetchImpl: fake.fetchImpl, spawnAge }));
    assert.deepEqual(await readdir(dir), []);
    await mkdir(join(dir, "storage-backup-encrypted")); await writeFile(join(dir, "storage-backup-encrypted", "existing"), PRIVATE);
    await assert.rejects(runBackup({ env: { ...env, RUNNER_TEMP: dir, SUPABASE_BACKUP_AGE_RECIPIENT: recipient }, fetchImpl: async () => assert.fail("must not fetch"), spawnAge }));
    assert.equal(await readFile(join(dir, "storage-backup-encrypted", "existing"), "utf8"), PRIVATE);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("manual workflow defaults to inventory, serializes migration, and publishes only fixed ciphertext", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/backup-supabase-storage.yml", import.meta.url), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /pull_request:|push:|id-token:|SUPABASE_DB_PASSWORD|upload-artifact[^\n]*\n[^]*path:.*\*/);
  assert.match(workflow, /default: inventory/);
  assert.match(workflow, /group: deploy-production/);
  assert.match(workflow, /github.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /path: \$\{\{ runner.temp \}\}\/storage-backup-encrypted\/storage-objects.mfmf.age/);
  assert.match(workflow, /retention-days: 90/);
});
