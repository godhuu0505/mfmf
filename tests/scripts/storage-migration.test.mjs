import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { readFile } from "node:fs/promises";
import { SOURCE_REF, MAGIC, frame, sha256, canonical, manifestFor } from "../../scripts/gcp/storage-backup-format.mjs";
import { createMigrationPlan, validateMigrationSnapshot, committedAssets, MIGRATION_SNAPSHOT_SQL, COMMIT_MIGRATION_SQL, ACTIVATE_MIGRATION_SQL, ROLLBACK_MIGRATION_SQL, CANCEL_STAGED_SQL } from "../../scripts/gcp/storage-migration-plan.mjs";
import { createOperatorGcs, MIGRATION_PROJECT, MIGRATION_PROJECT_NUMBER, OPERATOR_SA, STORAGE_WIF, MIGRATION_BUCKETS, bindingFor, isGeneration } from "../../scripts/gcp/storage-migration-gcs.mjs";
import { runMigration, RELEASE_SOURCE_SQL } from "../../scripts/gcp/storage-migration.mjs";
import { restoreBackup } from "../../scripts/gcp/restore-storage-backup.mjs";
import { probeSoftDelete } from "../../scripts/gcp/probe-storage-soft-delete.mjs";
import { cleanupStorage, EXPIRE_RESERVATIONS_SQL, DELETED_ASSETS_SQL } from "../../scripts/gcp/storage-migration-cleanup.mjs";

const PRIVATE = "PRIVATE_SYNTHETIC_VALUE";
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const body = Buffer.from(`fixture bytes ${PRIVATE}`);
const env = {
  GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "godhuu0505/mfmf", GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_WORKFLOW_REF: "godhuu0505/mfmf/.github/workflows/storage-migration.yml@refs/heads/main",
  SUPABASE_PROJECT_ID: SOURCE_REF, SUPABASE_ACCESS_TOKEN: `fixture-pat-${PRIVATE}`,
  GCP_PROJECT_ID: MIGRATION_PROJECT, GCP_PROJECT_NUMBER: MIGRATION_PROJECT_NUMBER,
  GCP_STORAGE_WIF_PROVIDER: STORAGE_WIF, GCP_STORAGE_SERVICE_ACCOUNT: OPERATOR_SA, GCP_ACCESS_TOKEN: "fixture-gcp-token",
};
function snapshot() {
  const photo = `legacy/${PRIVATE}/photo.jpg`, avatar = `legacy/${PRIVATE}/avatar.jpg`;
  return {
    formatVersion: 1, mode: "supabase", readBackend: "supabase", assets: [],
    base: { formatVersion: 1, readOnly: true, bypassRls: true,
      buckets: ["avatars", "daycare-photos"].map((id) => ({ id, name: id, public: false, fileSizeLimit: null, allowedMimeTypes: null })),
      objects: ["avatars", "daycare-photos"].map((bucket) => ({ bucket, path: bucket === "avatars" ? avatar : photo,
        version: "fixture-version", createdAt: "2026-10-27T00:00:00Z", updatedAt: "2026-10-27T00:00:00Z", metadata: { size: body.length, mimetype: "image/jpeg" } })),
      references: { record_photos: [photo], profiles: [avatar], households: [avatar], pets: [avatar] } },
    references: [
      { kind: "household", referenceId: uid(2), entityId: uid(2), householdId: uid(2), ownerId: null, referenceHouseholdId: uid(2), path: avatar, assetId: null },
      { kind: "pet", referenceId: uid(3), entityId: uid(3), householdId: uid(2), ownerId: uid(1), referenceHouseholdId: uid(2), path: avatar, assetId: null },
      { kind: "photo", referenceId: uid(5), entityId: uid(4), householdId: uid(2), ownerId: uid(1), referenceHouseholdId: uid(2), path: photo, assetId: null },
      { kind: "profile", referenceId: uid(1), entityId: uid(1), householdId: null, ownerId: uid(1), referenceHouseholdId: null, path: avatar, assetId: null },
    ],
  };
}
function archive(base = snapshot().base) {
  const entries = base.objects.map((object) => ({ bucket: object.bucket, path: object.path, size: body.length, hashes: { sha256: sha256(body) } }));
  return Buffer.concat([MAGIC, frame({ kind: "storage-backup", sourceRef: SOURCE_REF, snapshot: base }),
    ...entries.flatMap((_, index) => [frame({ kind: "object", index, size: body.length, sha256: sha256(body) }), body]),
    frame({ kind: "complete", manifest: manifestFor(base, entries), snapshotSha256: sha256(canonical(base)), consistency: "metadata-unchanged-between-reads" })]);
}
const archiveFactory = async function* () { yield archive(); };
function cloud() {
  const live = new Map(), deleted = new Map(), calls = []; let counter = 100;
  const key = (bucket, name) => `${bucket}/${name}`;
  const response = (object) => Response.json(object);
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    const u = new URL(url);
    assert.equal(u.origin, "https://storage.googleapis.com");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, "Bearer fixture-gcp-token");
    const parts = u.pathname.split("/");
    const bucket = parts[parts.indexOf("b") + 1];
    assert.ok(Object.values(MIGRATION_BUCKETS).includes(bucket));
    if (!parts.includes("o")) return response({ name: bucket, projectNumber: MIGRATION_PROJECT_NUMBER, location: "ASIA-NORTHEAST1", storageClass: "STANDARD",
      iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: "enforced" }, softDeletePolicy: { retentionDurationSeconds: "604800" } });
    const make = (name, bytes, details) => {
      const object = { meta: { bucket, name, generation: String(counter++), size: String(bytes.length), ...details }, bytes: Buffer.from(bytes) };
      live.set(key(bucket, name), object); return object;
    };
    if (u.pathname.startsWith("/upload/")) {
      assert.equal(u.searchParams.get("uploadType"), "media"); assert.equal(u.searchParams.get("ifGenerationMatch"), "0");
      const name = u.searchParams.get("name"); assert.match(name, /^_incoming\//);
      if (live.has(key(bucket, name))) return new Response(PRIVATE, { status: 412 });
      return response(make(name, options.body, { contentType: options.headers["Content-Type"] }).meta);
    }
    const name = decodeURIComponent(parts[parts.indexOf("o") + 1]);
    const current = live.get(key(bucket, name));
    if (u.pathname.endsWith("/restore")) {
      assert.equal(options.method, "POST"); assert.equal(u.searchParams.get("ifGenerationMatch"), "0");
      if (current) return new Response(PRIVATE, { status: 412 });
      const old = deleted.get(`${key(bucket, name)}@${u.searchParams.get("generation")}`);
      if (!old) return new Response(PRIVATE, { status: 404 });
      const { generation: _, ...rest } = old.meta;
      const restored = make(name, old.bytes, rest); restored.meta.generation = String(counter++);
      return response(restored.meta);
    }
    if (parts.includes("rewriteTo")) {
      assert.equal(options.method, "POST"); assert.equal(u.searchParams.get("sourceGeneration"), current.meta.generation);
      assert.equal(u.searchParams.get("ifSourceGenerationMatch"), current.meta.generation); assert.equal(u.searchParams.get("ifGenerationMatch"), "0");
      const final = decodeURIComponent(parts.at(-1));
      if (live.has(key(bucket, final))) return new Response(PRIVATE, { status: 412 });
      return response({ done: true, resource: make(final, current.bytes, JSON.parse(options.body)).meta });
    }
    if (!current || (u.searchParams.has("generation") && current.meta.generation !== u.searchParams.get("generation"))) return new Response(PRIVATE, { status: 404 });
    if (options.method === "DELETE") {
      assert.equal(u.searchParams.get("ifGenerationMatch"), current.meta.generation);
      deleted.set(`${key(bucket, name)}@${current.meta.generation}`, current); live.delete(key(bucket, name));
      return new Response(null, { status: 204 });
    }
    return u.searchParams.get("alt") === "media" ? new Response(current.bytes) : response(current.meta);
  };
  return { fetchImpl, live, deleted, calls };
}
function environment() {
  const fake = cloud(); let state = snapshot(); let allocated = 1000;
  const statements = [], receipts = [];
  const updateBaseRefs = () => {
    const tables = { photo: "record_photos", profile: "profiles", household: "households", pet: "pets" };
    for (const [kind, table] of Object.entries(tables)) state.base.references[table] = state.references.filter((ref) => ref.kind === kind).map((ref) => ref.path).sort();
  };
  const fetchImpl = async (url, options) => {
    if (url.startsWith("https://storage.googleapis.com/")) return fake.fetchImpl(url, options);
    assert.equal(options.redirect, "error");
    if (url.endsWith("/api-keys?reveal=true")) {
      const jwt = `fixture.${Buffer.from(JSON.stringify({ role: "service_role", ref: SOURCE_REF, exp: 4102444800 })).toString("base64url")}.signature`;
      return Response.json([{ name: "service_role", type: "legacy", api_key: jwt }]);
    }
    if (url.startsWith(`https://${SOURCE_REF}.supabase.co/storage/v1/object/`)) return new Response(body);
    assert.equal(url, `https://api.supabase.com/v1/projects/${SOURCE_REF}/database/query`);
    const { query, parameters, read_only } = JSON.parse(options.body); statements.push({ query, parameters, read_only });
    if (query === MIGRATION_SNAPSHOT_SQL) return Response.json([{ migration_snapshot: structuredClone(state) }]);
    assert.equal(read_only, false);
    if (query.includes("SELECT public.set_media_storage_mode('frozen') AS result")) { state.mode = "frozen"; return Response.json([{ result: null }]); }
    if (query === COMMIT_MIGRATION_SQL) {
      const payload = JSON.parse(parameters[0]); assert.deepEqual(state, payload.snapshot);
      state.assets = payload.assets.map((a) => ({ id: a.id, kind: a.kind, entityId: a.entityId, householdId: a.householdId, ownerId: a.ownerId,
        incomingKey: a.incomingKey, finalKey: a.finalKey, size: a.size, contentType: a.contentType, state: "ready", generation: a.generation,
        isLegacy: true, sha256: a.sha256, sourcePath: a.sourcePath, referenceId: a.referenceId }));
      return Response.json([{ result: { committed: state.assets.length, guard: 1 } }]);
    }
    if ([ACTIVATE_MIGRATION_SQL, ROLLBACK_MIGRATION_SQL, CANCEL_STAGED_SQL, RELEASE_SOURCE_SQL].includes(query)) {
      assert.deepEqual(state, JSON.parse(parameters[0]));
      if (query === ACTIVATE_MIGRATION_SQL) {
        for (const ref of state.references) { const a = state.assets.find((x) => x.kind === ref.kind && x.referenceId === ref.referenceId); ref.path = a.finalKey; ref.assetId = a.id; }
        state.mode = "gcs"; state.readBackend = "gcs"; updateBaseRefs();
        return Response.json([{ result: { activated: state.assets.length, modeChanged: null } }]);
      }
      if (query === RELEASE_SOURCE_SQL) { state.mode = "supabase"; state.readBackend = "supabase"; return Response.json([{ result: null }]); }
      for (const ref of state.references) { const a = state.assets.find((x) => x.kind === ref.kind && x.referenceId === ref.referenceId); ref.path = a.sourcePath; ref.assetId = null; }
      for (const asset of state.assets) asset.state = "deleted";
      state.mode = "supabase"; state.readBackend = "supabase";
      updateBaseRefs(); return Response.json([{ result: { rolledBack: state.assets.length, modeChanged: null } }]);
    }
    assert.fail("Unexpected SQL statement");
  };
  return { ...fake, fetchImpl, statements, receipts, get state() { return state; },
    options: { env, fetchImpl, archiveFactory, uuid: () => uid(allocated++),
      journalFactory: async () => ({ write: async (kind, bytes) => { receipts.push({ kind, bytes: Buffer.from(bytes) }); } }) } };
}

test("rich plan preserves row/parent identity and allocates each shared reference separately", () => {
  const s = snapshot(); s.mode = "frozen"; let next = 100;
  const plan = createMigrationPlan(s, { uuid: () => uid(next++) });
  assert.equal(plan.assets.length, 4); assert.equal(new Set(plan.assets.map((x) => x.id)).size, 4);
  assert.equal(plan.assets.filter((x) => x.sourcePath.includes("avatar")).length, 3);
  assert.equal(plan.assets.find((x) => x.kind === "photo").referenceId, uid(5));
  assert.equal(plan.assets.find((x) => x.kind === "photo").entityId, uid(4));
});
test("plan refuses source gaps, unsafe scope, unsupported MIME/size and already assigned references", () => {
  for (const mutate of [s => { s.base.objects = []; }, s => { s.references[0].householdId = uid(90); },
    s => { s.base.objects[0].metadata.mimetype = "image/svg+xml"; }, s => { s.base.objects[0].metadata.size = 2097153; },
    s => { s.references[0].assetId = uid(50); }, s => { s.references.pop(); }]) {
    const s = snapshot(); s.mode = "frozen"; mutate(s); assert.throws(() => createMigrationPlan(s));
  }
});
test("migration stages verified ledger but leaves old references and Supabase reads intact", async () => {
  const e = environment(); const old = structuredClone(e.state.references);
  const result = await runMigration({ ...e.options, mode: "migrate" });
  assert.equal(result.mode, "frozen"); assert.equal(result.copiedReferences, 4);
  assert.deepEqual(e.state.references, old); assert.equal(e.state.readBackend, "supabase");
  assert.equal(committedAssets(e.state).length, 4);
  assert.equal(e.receipts.filter((r) => r.kind === "backup").length, 1);
  assert.equal(JSON.stringify(result).includes(PRIVATE), false);
  assert.equal(e.live.size, 8); // source is untouched; GCS incoming + final per reference
});
test("activate requires restore gate, rechecks every final generation/hash, then changes refs+mode", async () => {
  const e = environment(); await runMigration({ ...e.options, mode: "migrate" });
  await assert.rejects(runMigration({ ...e.options, mode: "activate" }));
  const result = await runMigration({ ...e.options, mode: "activate", env: { ...env, STORAGE_RESTORE_VERIFIED: "true" } });
  assert.equal(result.mode, "gcs"); assert.equal(e.state.readBackend, "gcs");
  assert.ok(e.state.references.every((ref) => ref.assetId !== null));
  assert.equal(e.state.references.find((ref) => ref.kind === "photo").referenceId, uid(5));
});
test("staged and active rollback restore original reference IDs/paths without source deletion", async () => {
  for (const active of [false, true]) {
    const e = environment(); const old = structuredClone(e.state.references);
    await runMigration({ ...e.options, mode: "migrate" });
    if (active) await runMigration({ ...e.options, mode: "activate", env: { ...env, STORAGE_RESTORE_VERIFIED: "true" } });
    const result = await runMigration({ ...e.options, mode: "rollback" });
    assert.equal(result.mode, "supabase"); assert.equal(e.state.readBackend, "supabase");
    assert.deepEqual(e.state.references, old); assert.ok(e.state.assets.every((a) => a.state === "deleted"));
    assert.equal(e.calls.filter((c) => c.options.method === "DELETE").length, 0);
  }
});
test("changed bytes prevent activation and retain frozen mode; failed backup prevents any GCS write", async () => {
  const e = environment(); await runMigration({ ...e.options, mode: "migrate" });
  const object = [...e.live.values()].find((o) => !o.meta.name.startsWith("_incoming/")); object.bytes[0] ^= 1;
  await assert.rejects(runMigration({ ...e.options, mode: "activate", env: { ...env, STORAGE_RESTORE_VERIFIED: "true" } }));
  assert.equal(e.state.mode, "frozen");
  const other = environment();
  await assert.rejects(runMigration({ ...other.options, mode: "migrate", journalFactory: async () => ({ write: async (kind) => { if (kind === "backup") throw Error(PRIVATE); } }) }));
  assert.equal(other.state.mode, "frozen"); assert.equal(other.live.size, 0); assert.equal(other.state.assets.length, 0);
});
test("scheduled event cannot plan, migrate, activate or rollback", async () => {
  for (const mode of ["plan", "migrate", "activate", "rollback", "abort-staging"]) {
    let calls = 0;
    await assert.rejects(runMigration({ mode, env: { ...env, GITHUB_EVENT_NAME: "schedule" }, fetchImpl: async () => { calls++; } }));
    assert.equal(calls, 0);
  }
});
test("abort-staging requires fresh complete backup and rejects any ready/unknown committed ledger", async () => {
  const e = environment();
  await assert.rejects(runMigration({ ...e.options, mode: "migrate", journalFactory: async () => ({ write: async (kind) => { if (kind === "backup") throw Error(PRIVATE); } }) }));
  assert.equal(e.state.mode, "frozen"); assert.equal(e.state.assets.length, 0);
  const result = await runMigration({ ...e.options, mode: "abort-staging" });
  assert.equal(result.mode, "supabase"); assert.equal(result.orphanCleanup, "requires-prior-encrypted-receipt-review");
  const staged = environment(); await runMigration({ ...staged.options, mode: "migrate" });
  await assert.rejects(runMigration({ ...staged.options, mode: "abort-staging" }));
  assert.equal(staged.state.mode, "frozen"); assert.equal(staged.state.assets.length, 4);
});
test("fixed context rejects wrong project, WIF provider, service account and workflow", async () => {
  for (const override of [{ GCP_PROJECT_ID: "other" }, { GCP_STORAGE_WIF_PROVIDER: "other" }, { GCP_STORAGE_SERVICE_ACCOUNT: "deployer" }, { GITHUB_WORKFLOW_REF: "other" }, { SUPABASE_PROJECT_ID: "other" }]) {
    await assert.rejects(runMigration({ env: { ...env, ...override }, fetchImpl: async () => assert.fail("must not fetch") }));
  }
});
test("isolated restore verifies whole archive before authentication, uses new incoming keys, and deletes only returned generations", async () => {
  const c = cloud(); let i = 100;
  const result = await restoreBackup({ input: Readable.from([archive()]), apply: true, getToken: async () => "fixture-gcp-token", fetchImpl: c.fetchImpl, uuid: () => uid(i++) });
  assert.equal(result.restoredObjects, 2); assert.equal(c.live.size, 0);
  assert.ok(c.calls.filter((x) => x.options.method === "DELETE").every((x) => x.url.includes("_incoming%2F")));
  await assert.rejects(restoreBackup({ input: Readable.from([archive().subarray(0, -1)]), apply: true, getToken: async () => assert.fail("must not authenticate") }));
  assert.equal((await restoreBackup({ input: Readable.from([archive()]), getToken: async () => assert.fail("dry run") })).cloudWrites, 0);
});
test("soft-delete probe restores one synthetic generation create-only then deletes the new generation", async () => {
  const c = cloud();
  const result = await probeSoftDelete({ apply: true, getToken: async () => "fixture-gcp-token", fetchImpl: c.fetchImpl, uuid: () => uid(90) });
  assert.equal(result.restoredObjects, 1); assert.equal(result.deletedTestGenerations, 2); assert.equal(c.live.size, 0);
  assert.equal(c.calls.filter((x) => new URL(x.url).pathname.endsWith("/restore")).length, 1);
  assert.equal((await probeSoftDelete({ getToken: async () => assert.fail("dry run") })).cloudWrites, 0);
});
test("cleanup terminalizes first, deletes bound terminal generations, and reports mismatches without revival", async () => {
  const e = environment(); await runMigration({ ...e.options, mode: "migrate" });
  const assets = e.state.assets.map(({ id, kind, entityId, householdId, ownerId, incomingKey, finalKey, generation }) => ({ id, kind, entityId, householdId, ownerId, incomingKey, finalKey, generation }));
  const seen = []; const query = async (sql) => { seen.push(sql); return sql === EXPIRE_RESERVATIONS_SQL ? [{ expired: 2, guard: 1 }] : assets; };
  const result = await cleanupStorage({ query, gcs: createOperatorGcs({ token: env.GCP_ACCESS_TOKEN, fetchImpl: e.fetchImpl }) });
  assert.equal(seen[0], EXPIRE_RESERVATIONS_SQL); assert.equal(seen[1], DELETED_ASSETS_SQL);
  assert.equal(result.deletedGenerations, 8); assert.equal(result.failures, 0); assert.equal(e.live.size, 0);
  const other = environment(); await runMigration({ ...other.options, mode: "migrate" });
  const final = [...other.live.values()].find((o) => !o.meta.name.startsWith("_incoming/")); final.meta.metadata["mfmf-owner-id"] = uid(999);
  const bad = await cleanupStorage({ query, gcs: createOperatorGcs({ token: env.GCP_ACCESS_TOKEN, fetchImpl: other.fetchImpl }) });
  assert.equal(bad.failures, 1); assert.ok(other.live.has(`${final.meta.bucket}/${final.meta.name}`));
});
test("generation validation rejects numeric, zero and out-of-uint64 values", () => {
  for (const value of [0, 1, "0", "-1", "18446744073709551616", "1x"]) assert.equal(isGeneration(value), false);
  assert.equal(isGeneration("18446744073709551615"), true);
});
test("workflow schedule chooses cleanup independently of manual inputs and stores only encrypted outputs", async () => {
  const source = await readFile(new URL("../../.github/workflows/storage-migration.yml", import.meta.url), "utf8");
  assert.match(source, /cron: '0 18 \* \* \*'/); assert.match(source, /if \[ "\$EVENT_NAME" = schedule \]; then\n\s+echo 'mode=cleanup'/);
  assert.match(source, /default: plan/); assert.match(source, /create_credentials_file: false/);
  assert.doesNotMatch(source, /SUPABASE_DB_PASSWORD|VERCEL_TOKEN|GCP_DEPLOY_SERVICE_ACCOUNT/);
  assert.match(source, /storage-migration-encrypted\/receipt.age/);
});
