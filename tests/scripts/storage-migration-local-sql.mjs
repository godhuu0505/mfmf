#!/usr/bin/env node
// Isolated local DB only: clone schema (no data), test real ledger triggers/CAS,
// then drop only the uniquely created fixture DB. No existing application rows change.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import pg from "pg";
import assert from "node:assert/strict";
import { MIGRATION_SNAPSHOT_SQL, COMMIT_MIGRATION_SQL, ACTIVATE_MIGRATION_SQL, ROLLBACK_MIGRATION_SQL,
  CANCEL_STAGED_SQL, createMigrationPlan, committedAssets } from "../../scripts/gcp/storage-migration-plan.mjs";
import { EXPIRE_RESERVATIONS_SQL, DELETED_ASSETS_SQL } from "../../scripts/gcp/storage-migration-cleanup.mjs";

const name = `mfmf_storage_fixture_${randomUUID().replaceAll("-", "")}`;
const config = { host: "127.0.0.1", port: 54322, user: "postgres", password: "postgres", database: "postgres", connectionTimeoutMillis: 5000 };
const admin = new pg.Client(config);
let client, created = false, stage = "initialize";
const docker = (args, input) => execFileSync("docker", ["--host", "unix:///var/run/docker.sock", "exec", "-i", "supabase_db_mfmf", ...args],
  { env: { PATH: process.env.PATH }, input, timeout: 60_000, maxBuffer: 20 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
try {
  assert.equal(process.argv.length, 2);
  await admin.connect();
  stage = "clone-schema";
  const dump = docker(["pg_dump", "--username", "postgres", "--dbname", "postgres", "--schema-only", "--no-owner", "--no-privileges"]);
  await admin.query(`CREATE DATABASE ${name}`); created = true;
  client = new pg.Client({ ...config, database: name }); await client.connect();
  docker(["psql", "--username", "supabase_admin", "--dbname", name, "--no-psqlrc", "--quiet", "--set", "ON_ERROR_STOP=1"], dump);
  docker(["psql", "--username", "supabase_admin", "--dbname", name, "--no-psqlrc", "--quiet", "--set", "ON_ERROR_STOP=1"],
    Buffer.from("GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public,storage,auth TO postgres; GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public,storage,auth TO postgres; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public,storage,auth TO postgres; GRANT USAGE ON SCHEMA public,storage,auth TO postgres;"));
  stage = "seed-fixture";
  await client.query("BEGIN");
  await client.query("SET LOCAL statement_timeout = '10s'");
  await client.query("INSERT INTO public.media_storage_state(singleton,mode,read_backend) VALUES(true,'supabase','supabase')");
  stage = "empty-cleanup";
  assert.deepEqual((await client.query(EXPIRE_RESERVATIONS_SQL)).rows, [{ expired: 0, guard: 1 }]);
  assert.deepEqual((await client.query(DELETED_ASSETS_SQL, [null])).rows, []);
  stage = "seed-fixture";
  await client.query("INSERT INTO storage.buckets(id,name,public) VALUES('avatars','avatars',false),('daycare-photos','daycare-photos',false)");
  const owner = randomUUID(), household = randomUUID(), pet = randomUUID(), record = randomUUID(), photo = randomUUID();
  await client.query("INSERT INTO auth.users(id,email) VALUES($1,'storage-fixture@example.invalid')", [owner]);
  await client.query("INSERT INTO public.households(id,name,avatar_path) VALUES($1,'fixture','fixture/shared.jpg')", [household]);
  await client.query("INSERT INTO public.household_members(household_id,user_id,role) VALUES($1,$2,'owner')", [household, owner]);
  await client.query("INSERT INTO public.pets(id,owner_id,household_id,name,avatar_path) VALUES($1,$2,$3,'fixture','fixture/shared.jpg')", [pet, owner, household]);
  await client.query("INSERT INTO public.profiles(owner_id,avatar_path,display_name) VALUES($1,'fixture/shared.jpg','preserve fixture') ON CONFLICT(owner_id) DO UPDATE SET avatar_path=excluded.avatar_path,display_name=excluded.display_name", [owner]);
  await client.query("INSERT INTO public.daycare_records(id,owner_id,household_id,record_date,body) VALUES($1,$2,$3,'2026-10-27','preserve record body')", [record, owner, household]);
  await client.query("INSERT INTO public.record_photos(id,record_id,household_id,storage_path) VALUES($1,$2,$3,'fixture/photo.jpg')", [photo, record, household]);
  await client.query("INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('avatars','fixture/shared.jpg',$1),('daycare-photos','fixture/photo.jpg',$1)", [JSON.stringify({ size: 42, mimetype: "image/jpeg" })]);
  const snapshot = async () => {
    const value = (await client.query(MIGRATION_SNAPSHOT_SQL)).rows[0].migration_snapshot;
    // The fixture holds a write transaction; production inventory is a separate
    // read_only API request. Normalize only this contextual flag for real CAS SQL.
    value.base.readOnly = true; return value;
  };
  await client.query("SELECT public.set_media_storage_mode('frozen')");
  const initial = await snapshot(); const originalRefs = structuredClone(initial.references);
  const plan = createMigrationPlan(initial);
  const assets = plan.assets.map((asset, i) => ({ ...asset, sha256: "a".repeat(64), incomingGeneration: String(100 + i), generation: String(200 + i) }));
  stage = "stage-ledger";
  const staged = await client.query(COMMIT_MIGRATION_SQL, [JSON.stringify({ snapshot: initial, assets })]);
  assert.equal(staged.rows[0].result.committed, 4);
  const frozen = await snapshot(); assert.equal(frozen.readBackend, "supabase"); assert.deepEqual(frozen.references, originalRefs); assert.equal(committedAssets(frozen).length, 4);

  stage = "reject-stale-cas";
  await client.query("SAVEPOINT stale_cas");
  await client.query("UPDATE public.profiles SET avatar_path='fixture/changed.jpg' WHERE owner_id=$1", [owner]);
  let rejected = false;
  try { await client.query(ACTIVATE_MIGRATION_SQL, [JSON.stringify(frozen)]); } catch { rejected = true; }
  assert.equal(rejected, true); await client.query("ROLLBACK TO SAVEPOINT stale_cas");
  assert.deepEqual((await snapshot()).references, originalRefs);

  stage = "activate-atomically";
  const activated = await client.query(ACTIVATE_MIGRATION_SQL, [JSON.stringify(frozen)]);
  assert.equal(activated.rows[0].result.activated, 4);
  const active = await snapshot(); assert.equal(active.mode, "gcs"); assert.equal(active.readBackend, "gcs");
  assert.equal(active.references.find((ref) => ref.kind === "photo").referenceId, photo);
  assert.equal((await client.query("SELECT body FROM public.daycare_records WHERE id=$1", [record])).rows[0].body, "preserve record body");
  assert.equal((await client.query("SELECT display_name FROM public.profiles WHERE owner_id=$1", [owner])).rows[0].display_name, "preserve fixture");

  stage = "inverse-cas";
  await client.query("SELECT public.set_media_storage_mode('frozen')");
  const rollback = await snapshot(); assert.equal(rollback.readBackend, "gcs"); assert.equal(committedAssets(rollback, "active").length, 4);
  const reverted = await client.query(ROLLBACK_MIGRATION_SQL, [JSON.stringify(rollback)]);
  assert.equal(reverted.rows[0].result.rolledBack, 4);
  const old = await snapshot(); assert.deepEqual(old.references, originalRefs); assert.ok(old.assets.every((asset) => asset.state === "deleted"));
  assert.equal(old.mode, "supabase");
  assert.equal((await snapshot()).readBackend, "supabase");

  stage = "cancel-staged";
  await client.query("SELECT public.set_media_storage_mode('frozen')");
  const repeat = await snapshot(); const next = createMigrationPlan(repeat).assets.map((asset, i) => ({ ...asset, sha256: "b".repeat(64), incomingGeneration: String(300 + i), generation: String(400 + i) }));
  await client.query(COMMIT_MIGRATION_SQL, [JSON.stringify({ snapshot: repeat, assets: next })]);
  const cancel = await client.query(CANCEL_STAGED_SQL, [JSON.stringify(await snapshot())]);
  assert.equal(cancel.rows[0].result.rolledBack, 4); assert.deepEqual((await snapshot()).references, originalRefs);
  assert.equal((await snapshot()).readBackend, "supabase");
  await client.query("ROLLBACK");
  process.stdout.write("Local isolated Storage SQL passed: empty cleanup, staging, stale CAS rejection, atomic activation, inverse rollback, and staged cancellation.\n");
} catch {
  // Only the fixed phase name, never SQL text, row values, URLs or PG diagnostics.
  process.stderr.write(`Local isolated Storage SQL failed at ${stage}; details withheld.\n`); process.exitCode = 1;
} finally {
  await client?.query("ROLLBACK").catch(() => {}); await client?.end().catch(() => {});
  if (created) await admin.query(`DROP DATABASE ${name} WITH (FORCE)`).catch(() => { process.exitCode = 1; });
  await admin.end().catch(() => {});
}
