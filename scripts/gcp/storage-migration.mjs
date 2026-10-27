#!/usr/bin/env node
import { Readable } from "node:stream";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { backupArchive, storageKey, objectUrl } from "./backup-supabase-storage.mjs";
import { canonical, decodeArchiveForOperator, requireValue, fail, sha256, MAX_TOTAL_BYTES, MAX_JSON_BYTES } from "./storage-backup-format.mjs";
import { createOperatorGcs, bindingFor, responseBytes } from "./storage-migration-gcs.mjs";
import { requireMigrationContext, managementQuery, encryptedJournal } from "./storage-migration-io.mjs";
import { cleanupStorage } from "./storage-migration-cleanup.mjs";
import { cleanupStage, cleanupDiagnostic } from "./storage-migration-diagnostics.mjs";
import { diagnoseCleanup } from "./storage-cleanup-diagnosis.mjs";
import { MIGRATION_SNAPSHOT_SQL, COMMIT_MIGRATION_SQL, ACTIVATE_MIGRATION_SQL, ROLLBACK_MIGRATION_SQL, CANCEL_STAGED_SQL,
  validateMigrationSnapshot, createMigrationPlan, migrationSummary, committedAssets, normalizedSnapshotSql } from "./storage-migration-plan.mjs";

const FREEZE_SQL = "SELECT public.set_media_storage_mode('frozen') AS result";
export const RELEASE_SOURCE_SQL = `WITH locked AS MATERIALIZED (SELECT public.set_media_storage_mode('frozen')),
live AS (${MIGRATION_SNAPSHOT_SQL})
SELECT public.set_media_storage_mode(CASE WHEN (SELECT count(*) FROM locked) = 1
  AND public.media_is_operator() AND ${normalizedSnapshotSql("(SELECT migration_snapshot FROM live)")} = $1::jsonb
  AND (SELECT mode FROM public.media_storage_state WHERE singleton) = 'frozen'
  THEN 'supabase' ELSE 'invalid' END) AS result`;

const identity = (bucket, path) => JSON.stringify([bucket, path]);
const logicalBucket = (kind) => kind === "photo" ? "daycare-photos" : "avatars";
const physicalBucket = (kind) => kind === "photo" ? "photos" : "avatars";
const equal = (left, right) => requireValue(canonical(left) === canonical(right));
const sameApartFromMode = (left, right) => equal({ ...left, mode: right.mode }, right);
async function collectBackup(archiveFactory, options) {
  const chunks = []; let total = 0;
  for await (const chunk of archiveFactory(options)) {
    total += chunk.length; requireValue(total <= MAX_TOTAL_BYTES + 4 * MAX_JSON_BYTES); chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks, total);
  return { bytes, decoded: await decodeArchiveForOperator(Readable.from([bytes])) };
}
function verifyActivated(staged, active) {
  const expected = structuredClone(staged); expected.mode = "gcs"; expected.readBackend = "gcs";
  const table = { photo: "record_photos", profile: "profiles", household: "households", pet: "pets" };
  for (const ref of expected.references) {
    const asset = expected.assets.find((item) => item.state === "ready" && item.kind === ref.kind && item.referenceId === ref.referenceId);
    requireValue(asset); ref.path = asset.finalKey; ref.assetId = asset.id;
  }
  for (const [kind, name] of Object.entries(table)) {
    const unset = expected.base.references[name].filter((path) => path === null);
    expected.base.references[name] = [...unset, ...expected.references.filter((ref) => ref.kind === kind).map((ref) => ref.path).sort()];
  }
  equal(expected, active);
}

export async function runMigration({ mode = "plan", env, fetchImpl = fetch,
  signal = AbortSignal.timeout(20 * 60_000), journalFactory = encryptedJournal, uuid,
  archiveFactory = backupArchive }) {
  requireMigrationContext(env);
  requireValue(["plan", "migrate", "activate", "rollback", "abort-staging", "cleanup", "diagnose-cleanup"].includes(mode));
  requireValue(env.GITHUB_EVENT_NAME !== "schedule" || mode === "cleanup");
  const query = managementQuery({ env, fetchImpl, signal });
  if (mode === "diagnose-cleanup") return diagnoseCleanup(query);
  if (mode === "cleanup") {
    const gcs = createOperatorGcs({ token: env.GCP_ACCESS_TOKEN, fetchImpl, signal });
    await cleanupStage("verify-buckets", () => gcs.verifyBuckets());
    return cleanupStorage({ query, gcs });
  }
  const snapshot = async () => {
    const rows = await query(MIGRATION_SNAPSHOT_SQL);
    requireValue(Array.isArray(rows) && rows.length === 1 && Object.keys(rows[0]).length === 1);
    return validateMigrationSnapshot(rows[0].migration_snapshot);
  };
  const before = await snapshot();
  if (mode === "plan") return migrationSummary(before);
  if (mode === "activate") requireValue(env.STORAGE_RESTORE_VERIFIED === "true");
  const gcs = createOperatorGcs({ token: env.GCP_ACCESS_TOKEN, fetchImpl, signal });
  await gcs.verifyBuckets();
  const journal = await journalFactory(env, signal);
  const receipt = { formatVersion: 1, operation: mode, stage: "prepared", outcome: "started", snapshot: before, assets: [], objects: [] };
  const save = async () => journal.write("receipt", Buffer.from(JSON.stringify(receipt)));
  await journal.write("snapshot", Buffer.from(JSON.stringify(before)));
  await save();
  try {
    if (mode === "abort-staging") {
      requireValue(before.mode === "frozen" && before.readBackend === "supabase" && before.references.every((ref) => ref.assetId === null));
      requireValue(before.assets.every((asset) => asset.state === "deleted"));
      requireValue(migrationSummary(before).missingReferencedObjects === 0);
      const { bytes, decoded } = await collectBackup(archiveFactory, { env, fetchImpl, signal });
      equal(decoded.snapshot, before.base);
      await journal.write("backup", bytes);
      equal(await snapshot(), before);
      receipt.stage = "abort-staging-release-attempted"; await save();
      await query(RELEASE_SOURCE_SQL, { parameters: [JSON.stringify(before)], write: true });
      const after = await snapshot(); equal({ ...before, mode: "supabase" }, after);
      receipt.stage = "source-resumed-orphans-unassessed"; receipt.outcome = "completed"; await save();
      return { operation: "storage-abort-staging", mode: "supabase", readiness: "not-assessed", orphanCleanup: "requires-prior-encrypted-receipt-review" };
    }
    if (mode === "migrate") {
      requireValue(before.mode === "supabase" && before.references.every((ref) => ref.assetId === null));
      requireValue(before.assets.every((asset) => asset.state === "deleted"));
      receipt.stage = "freeze-attempted"; await save();
      await query(FREEZE_SQL, { write: true });
      const frozen = await snapshot(); requireValue(frozen.mode === "frozen"); sameApartFromMode(before, frozen);
      const plan = createMigrationPlan(frozen, { uuid });
      receipt.snapshot = frozen; receipt.assets = plan.assets; receipt.stage = "frozen"; await save();

      // One bounded in-memory backup also supplies the copy bytes. Re-reading
      // a mutable source after backup must not silently change what is migrated.
      const { bytes: archive, decoded } = await collectBackup(archiveFactory, { env, fetchImpl, signal });
      equal(decoded.snapshot, frozen.base);
      await journal.write("backup", archive);
      const bodies = new Map(decoded.objects.map((item) => [identity(item.bucket, item.path), item]));
      const planned = plan.assets.map((asset) => {
        const object = bodies.get(identity(logicalBucket(asset.kind), asset.sourcePath));
        requireValue(object && object.bytes.length === asset.size);
        return { ...asset, sha256: object.sha256 };
      });
      receipt.assets = planned; receipt.stage = "backup-verified"; await save();
      equal(await snapshot(), frozen);

      const completed = [];
      for (const asset of planned) {
        receipt.stage = "copy-in-progress"; await save();
        const result = await gcs.copyAsset(asset, bodies.get(identity(logicalBucket(asset.kind), asset.sourcePath)).bytes,
          async (object) => { receipt.objects.push(object); await save(); });
        completed.push(result);
        receipt.assets = [...completed, ...planned.slice(completed.length)]; await save();
      }
      equal(await snapshot(), frozen);
      receipt.stage = "commit-attempted"; await save();
      const result = await query(COMMIT_MIGRATION_SQL, { parameters: [JSON.stringify({ snapshot: frozen, assets: completed })], write: true });
      requireValue(result?.length === 1 && result[0].result?.guard === 1 && result[0].result.committed === completed.length);
      const after = await snapshot();
      const committed = committedAssets(after);
      requireValue(committed.length === completed.length);
      for (const asset of committed) {
        const expected = completed.find((item) => item.id === asset.id); requireValue(expected);
        for (const key of ["kind", "referenceId", "entityId", "householdId", "ownerId", "sourcePath", "size", "contentType", "finalKey", "sha256", "generation"]) requireValue(asset[key] === expected[key]);
      }
      receipt.stage = "staged-frozen"; receipt.outcome = "completed"; await save();
      return { operation: "storage-migration", mode: "frozen", readiness: "not-assessed", copiedReferences: completed.length,
        copiedBytes: completed.reduce((sum, asset) => sum + asset.size, 0) };
    }

    let frozen = before;
    if (mode === "rollback" && before.mode === "gcs") {
      receipt.stage = "freeze-attempted"; await save();
      await query(FREEZE_SQL, { write: true });
      frozen = await snapshot(); requireValue(frozen.mode === "frozen"); sameApartFromMode(before, frozen);
    }
    const phase = mode === "activate" || frozen.references.every((ref) => ref.assetId === null) ? "staged" : "active";
    const assets = committedAssets(frozen, phase);
    receipt.snapshot = frozen; receipt.assets = assets; receipt.stage = "checking-generations"; await save();
    for (const asset of assets) {
      const bucket = physicalBucket(asset.kind);
      const metadata = await gcs.stat(bucket, asset.finalKey, asset.generation);
      const binding = bindingFor(asset, metadata.metadata?.["mfmf-source-generation"]);
      equal(metadata.metadata, binding);
      requireValue(Number(metadata.size) === asset.size && metadata.contentType === asset.contentType && metadata.contentEncoding === "identity");
      requireValue(sha256(await gcs.read(bucket, asset.finalKey, asset.generation, asset.size)) === asset.sha256);
    }
    equal(await snapshot(), frozen);
    if (mode === "activate") {
      receipt.stage = "activate-attempted"; await save();
      const result = await query(ACTIVATE_MIGRATION_SQL, { parameters: [JSON.stringify(frozen)], write: true });
      requireValue(result?.length === 1 && result[0].result?.activated === assets.length);
      const after = await snapshot(); requireValue(after.mode === "gcs"); verifyActivated(frozen, after);
      receipt.stage = "activated"; receipt.outcome = "completed"; await save();
      return { operation: "storage-activation", mode: "gcs", verifiedReferences: assets.length };
    }

    // Limited inverse migration only, before any non-legacy GCS user upload.
    // Source bodies must still exactly match the immutable original digest.
    let key = await storageKey({ env, fetchImpl, signal });
    const checked = new Map();
    try {
      for (const asset of assets) {
        const source = { bucket: logicalBucket(asset.kind), path: asset.sourcePath };
        const id = identity(source.bucket, source.path);
        if (!checked.has(id)) {
          const response = await fetchImpl(objectUrl(source), { method: "GET", headers: { apikey: key, Authorization: `Bearer ${key}`, "Accept-Encoding": "identity", "Cache-Control": "no-cache" }, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) });
          if (response.status !== 200) { await response.body?.cancel().catch(() => {}); fail(); }
          const bytes = await responseBytes(response, asset.size); requireValue(bytes.length === asset.size);
          checked.set(id, sha256(bytes));
        }
        requireValue(checked.get(id) === asset.sha256);
      }
    } finally { key = undefined; }
    equal(await snapshot(), frozen);
    receipt.stage = "rollback-attempted"; await save();
    const result = await query(phase === "staged" ? CANCEL_STAGED_SQL : ROLLBACK_MIGRATION_SQL, { parameters: [JSON.stringify(frozen)], write: true });
    requireValue(result?.length === 1 && result[0].result?.rolledBack === assets.length);
    const reverted = await snapshot();
    requireValue(reverted.mode === "supabase" && reverted.readBackend === "supabase" && reverted.references.every((ref) => ref.assetId === null));
    for (const ref of reverted.references) {
      const expected = assets.find((asset) => asset.kind === ref.kind && asset.referenceId === ref.referenceId);
      requireValue(expected && ref.path === expected.sourcePath && ref.entityId === expected.entityId && ref.householdId === expected.householdId && ref.ownerId === expected.ownerId);
    }
    requireValue(reverted.references.length === assets.length && reverted.assets.every((asset) => asset.state === "deleted"));
    receipt.stage = "rolled-back"; receipt.outcome = "completed"; await save();
    return { operation: "storage-rollback", mode: "supabase", restoredReferences: assets.length, sourceDeleted: 0 };
  } catch {
    // A lost response may hide a completed write. Never retry/undo blindly or
    // unfreeze on failure. Keep encrypted intent + any observed generations.
    receipt.outcome = "failed-or-unknown";
    try { await save(); } catch { /* retain the last successfully encrypted receipt */ }
    fail();
  }
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const controller = new AbortController(); const stop = () => controller.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    requireValue(args.length <= 1);
    const result = await runMigration({ mode: args[0] ?? "plan", env,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20 * 60_000)]) });
    await new Promise((done, reject) => process.stdout.write(`${JSON.stringify(result)}\n`, (error) => error ? reject(error) : done()));
    return result.failures > 0 ? 1 : 0;
  } catch (error) {
    process.stderr.write(cleanupDiagnostic(error) ?? "Storage operator stopped; outcome may be incomplete. Inspect encrypted receipt; no automatic unfreeze.\n");
    return 1;
  } finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.stdout.on("error", () => { process.exitCode = 1; }); process.stderr.on("error", () => { process.exitCode = 1; });
  process.exitCode = await main();
}
