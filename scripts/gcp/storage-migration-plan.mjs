import { randomUUID } from "node:crypto";
import { INVENTORY_SQL } from "./backup-supabase-storage.mjs";
import { exact, requireValue, validateSnapshot, canonical, sha256, summarize } from "./storage-backup-format.mjs";
import { UUID, GENERATION, TYPES, finalKey } from "./storage-migration-gcs.mjs";

const TABLES = { photo: "record_photos", profile: "profiles", household: "households", pet: "pets" };
const logicalBucket = (kind) => kind === "photo" ? "daycare-photos" : "avatars";
const identity = (bucket, path) => JSON.stringify([bucket, path]);

// All original row IDs and scope are retained; no personal text/email is selected.
export const MIGRATION_SNAPSHOT_SQL = `WITH base AS (${INVENTORY_SQL}),
refs AS (
  SELECT 'photo'::text AS kind, p.id AS reference_id, p.record_id AS entity_id,
    r.household_id, r.owner_id, p.household_id AS reference_household_id,
    p.storage_path AS path, p.media_asset_id AS asset_id
    FROM public.record_photos p JOIN public.daycare_records r ON r.id = p.record_id
  UNION ALL SELECT 'profile', owner_id, owner_id, NULL::uuid, owner_id, NULL::uuid, avatar_path, avatar_asset_id
    FROM public.profiles WHERE avatar_path IS NOT NULL OR avatar_asset_id IS NOT NULL
  UNION ALL SELECT 'household', id, id, id, NULL::uuid, id, avatar_path, avatar_asset_id
    FROM public.households WHERE avatar_path IS NOT NULL OR avatar_asset_id IS NOT NULL
  UNION ALL SELECT 'pet', id, id, household_id, owner_id, household_id, avatar_path, avatar_asset_id
    FROM public.pets WHERE avatar_path IS NOT NULL OR avatar_asset_id IS NOT NULL
), bounded_refs AS (SELECT * FROM refs ORDER BY kind, reference_id LIMIT 5001)
SELECT jsonb_build_object(
  'formatVersion', 1, 'mode', (SELECT mode FROM public.media_storage_state WHERE singleton),
  'readBackend', (SELECT read_backend FROM public.media_storage_state WHERE singleton),
  'base', (SELECT snapshot FROM base),
  'references', COALESCE((SELECT jsonb_agg(jsonb_build_object('kind',kind,'referenceId',reference_id,
    'entityId',entity_id,'householdId',household_id,'ownerId',owner_id,'referenceHouseholdId',reference_household_id,
    'path',path,'assetId',asset_id) ORDER BY kind,reference_id) FROM bounded_refs), '[]'::jsonb),
  'assets', COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'kind',kind,'entityId',entity_id,
    'householdId',household_id,'ownerId',owner_id,'incomingKey',incoming_key,'finalKey',final_key,
    'size',byte_size,'contentType',content_type,'state',state,'generation',generation,'isLegacy',is_legacy,
    'sha256',legacy_sha256,'sourcePath',legacy_path,'referenceId',legacy_reference_id)
    ORDER BY id) FROM (SELECT * FROM public.media_assets ORDER BY id LIMIT 5001) AS bounded_assets), '[]'::jsonb)
) AS migration_snapshot`;

export function validateMigrationSnapshot(value) {
  exact(value, ["formatVersion", "mode", "readBackend", "base", "references", "assets"]);
  requireValue(value.formatVersion === 1 && ["supabase", "frozen", "gcs"].includes(value.mode));
  requireValue(["supabase", "gcs"].includes(value.readBackend) && (value.mode === "frozen" || value.mode === value.readBackend));
  validateSnapshot(value.base);
  requireValue(Array.isArray(value.references) && value.references.length <= 4000 && Array.isArray(value.assets) && value.assets.length <= 4000);
  const seen = new Set();
  const derived = { record_photos: [], profiles: [], households: [], pets: [] };
  for (const ref of value.references) {
    exact(ref, ["kind", "referenceId", "entityId", "householdId", "ownerId", "referenceHouseholdId", "path", "assetId"]);
    requireValue(Object.hasOwn(TABLES, ref.kind) && UUID.test(ref.referenceId) && UUID.test(ref.entityId));
    requireValue(ref.kind === "household" ? ref.ownerId === null && ref.entityId === ref.householdId : UUID.test(ref.ownerId));
    requireValue(ref.kind === "profile" ? ref.householdId === null && ref.entityId === ref.ownerId : UUID.test(ref.householdId));
    requireValue(ref.referenceHouseholdId === ref.householdId && (ref.kind === "photo" || ref.referenceId === ref.entityId));
    requireValue(ref.assetId === null || UUID.test(ref.assetId));
    requireValue(typeof ref.path === "string" && ref.path.length > 0);
    const key = `${ref.kind}:${ref.referenceId}`; requireValue(!seen.has(key)); seen.add(key);
    derived[TABLES[ref.kind]].push(ref.path);
  }
  for (const table of Object.keys(derived)) {
    requireValue(canonical(derived[table].sort()) === canonical(value.base.references[table].filter((path) => path !== null).sort()));
  }
  return value;
}

export function createMigrationPlan(snapshot, { uuid = randomUUID } = {}) {
  validateMigrationSnapshot(snapshot);
  requireValue(snapshot.mode === "frozen" && snapshot.readBackend === "supabase" && snapshot.references.length > 0);
  requireValue(snapshot.references.every((ref) => ref.assetId === null));
  requireValue(snapshot.assets.every((asset) => asset.state === "deleted"));
  const objects = new Map(snapshot.base.objects.map((entry) => [identity(entry.bucket, entry.path), entry]));
  const allocated = new Set();
  const assets = snapshot.references.map((ref) => {
    const source = objects.get(identity(logicalBucket(ref.kind), ref.path)); requireValue(source);
    const size = source.metadata.size;
    const contentType = source.metadata.mimetype;
    requireValue(size > 0 && size <= (ref.kind === "photo" ? 10 * 1024 * 1024 : 2 * 1024 * 1024) && TYPES.includes(contentType));
    const id = uuid(); requireValue(UUID.test(id) && !allocated.has(id)); allocated.add(id);
    const result = { id, kind: ref.kind, referenceId: ref.referenceId, entityId: ref.entityId,
      householdId: ref.householdId, ownerId: ref.ownerId, sourcePath: ref.path,
      size, contentType, incomingKey: `_incoming/${id}` };
    return { ...result, finalKey: finalKey(result) };
  });
  return { formatVersion: 1, snapshot, snapshotSha256: sha256(canonical(snapshot)), assets };
}

export function migrationSummary(snapshot) {
  validateMigrationSnapshot(snapshot);
  return { operation: "storage-migration-plan", readiness: "not-assessed", mode: snapshot.mode,
    ...summarize(snapshot.base), referenceRowsToCopy: snapshot.references.length,
    existingAssets: snapshot.assets.length,
    estimatedCopiedBytes: snapshot.references.reduce((sum, ref) => {
      const object = snapshot.base.objects.find((item) => item.bucket === logicalBucket(ref.kind) && item.path === ref.path);
      return sum + (object?.metadata.size ?? 0);
    }, 0) };
}

export function committedAssets(snapshot, phase = "staged") {
  requireValue(phase === "staged" || phase === "active");
  validateMigrationSnapshot(snapshot);
  requireValue(snapshot.mode === "frozen" && snapshot.references.length > 0);
  requireValue(snapshot.readBackend === (phase === "staged" ? "supabase" : "gcs"));
  const assets = new Map();
  for (const asset of snapshot.assets) {
    exact(asset, ["id", "kind", "entityId", "householdId", "ownerId", "incomingKey", "finalKey", "size", "contentType", "state", "generation", "isLegacy", "sha256", "sourcePath", "referenceId"]);
    requireValue(asset.isLegacy === true); // First cutover/rollback only; not a general post-write reverse sync.
    if (asset.state === "deleted") continue;
    requireValue(asset.state === "ready" && UUID.test(asset.id) && UUID.test(asset.referenceId) && GENERATION.test(asset.generation));
    requireValue(asset.incomingKey === `_incoming/${asset.id}` && asset.finalKey === finalKey(asset));
    requireValue(Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= (asset.kind === "photo" ? 10 * 1024 * 1024 : 2 * 1024 * 1024));
    requireValue(TYPES.includes(asset.contentType) && typeof asset.sourcePath === "string" && asset.sourcePath.length > 0 && /^[a-f0-9]{64}$/.test(asset.sha256));
    requireValue(!assets.has(asset.id)); assets.set(asset.id, asset);
  }
  requireValue(assets.size === snapshot.references.length);
  const seen = new Set();
  for (const ref of snapshot.references) {
    const asset = phase === "active" ? assets.get(ref.assetId)
      : [...assets.values()].find((item) => item.kind === ref.kind && item.referenceId === ref.referenceId);
    requireValue(asset && !seen.has(asset.id)); seen.add(asset.id);
    requireValue(phase === "active" ? ref.assetId === asset.id : ref.assetId === null);
    requireValue(ref.kind === asset.kind && ref.referenceId === asset.referenceId && ref.entityId === asset.entityId &&
      ref.householdId === asset.householdId && ref.ownerId === asset.ownerId && ref.path === (phase === "active" ? asset.finalKey : asset.sourcePath));
  }
  return [...assets.values()];
}

// Read-only snapshots carry readOnly=true. A write-statement comparison must
// ignore only that contextual flag; all object/ref/scope/ledger values remain exact.
export const normalizedSnapshotSql = (expression) => `jsonb_set(${expression}, '{base,readOnly}', 'true'::jsonb)`;

const INPUT_ASSETS = `SELECT * FROM jsonb_to_recordset($1::jsonb->'assets') AS a(
  id uuid, kind text, "referenceId" uuid, "entityId" uuid, "householdId" uuid, "ownerId" uuid,
  "sourcePath" text, size bigint, "contentType" text, "incomingKey" text, "finalKey" text,
  sha256 text, "incomingGeneration" text, generation text)`;

// Stage verified legacy assets only. Old references remain readable until the
// separate activate transaction changes every reference and read backend together.
export const COMMIT_MIGRATION_SQL = `WITH
mode_lock AS MATERIALIZED (SELECT mode FROM public.media_storage_state WHERE singleton FOR UPDATE),
live AS (${MIGRATION_SNAPSHOT_SQL}),
inputs AS (${INPUT_ASSETS}),
guard AS MATERIALIZED (SELECT 1 / ((public.media_is_operator() AND (SELECT mode FROM mode_lock) = 'frozen'
  AND ${normalizedSnapshotSql("(SELECT migration_snapshot FROM live)")} = ($1::jsonb->'snapshot')
  AND (SELECT count(*) FROM inputs) = jsonb_array_length($1::jsonb->'snapshot'->'references')
  AND (SELECT count(*) FROM inputs) > 0)::int) AS ok),
inserted AS (
  INSERT INTO public.media_assets(id,kind,entity_id,household_id,owner_id,created_by,incoming_key,final_key,
    byte_size,content_type,state,expires_at,generation,is_legacy,legacy_sha256,legacy_path,legacy_reference_id)
  SELECT id,kind,"entityId","householdId","ownerId",NULL,"incomingKey","finalKey",size,"contentType",'ready',
    now(),generation,true,sha256,"sourcePath","referenceId" FROM inputs CROSS JOIN guard WHERE guard.ok = 1
  RETURNING *
)
SELECT jsonb_build_object('committed', (SELECT count(*) FROM inserted), 'guard', 1 / (
  ((SELECT count(*) FROM inputs) = (SELECT count(*) FROM inserted))::int)) AS result`;

// The old references remain readable throughout frozen staging. Reference CAS
// and the mode switch happen together; no intermediate new-path/Supabase state.
export const ACTIVATE_MIGRATION_SQL = `WITH
mode_lock AS MATERIALIZED (SELECT mode FROM public.media_storage_state WHERE singleton FOR UPDATE),
live AS (${MIGRATION_SNAPSHOT_SQL}),
guard AS MATERIALIZED (SELECT 1 / ((public.media_is_operator() AND (SELECT mode FROM mode_lock) = 'frozen'
  AND ${normalizedSnapshotSql("(SELECT migration_snapshot FROM live)")} = $1::jsonb)::int) AS ok),
assets AS MATERIALIZED (SELECT a.* FROM public.media_assets a CROSS JOIN guard
  WHERE guard.ok = 1 AND a.is_legacy AND a.state = 'ready'
), photos AS (
  UPDATE public.record_photos p SET storage_path = a.final_key, media_asset_id = a.id
  FROM assets a, public.daycare_records r WHERE a.kind = 'photo' AND p.id = a.legacy_reference_id
    AND p.record_id = a.entity_id AND r.id = p.record_id AND r.household_id = a.household_id
    AND r.owner_id = a.owner_id AND p.household_id = a.household_id AND p.storage_path = a.legacy_path
    AND p.media_asset_id IS NULL RETURNING p.id
), profiles AS (
  UPDATE public.profiles p SET avatar_path = a.final_key, avatar_asset_id = a.id FROM assets a
  WHERE a.kind = 'profile' AND p.owner_id = a.entity_id AND a.legacy_reference_id = p.owner_id
    AND a.owner_id = p.owner_id AND a.household_id IS NULL AND p.avatar_path = a.legacy_path
    AND p.avatar_asset_id IS NULL RETURNING p.owner_id
), households AS (
  UPDATE public.households h SET avatar_path = a.final_key, avatar_asset_id = a.id FROM assets a
  WHERE a.kind = 'household' AND h.id = a.entity_id AND a.legacy_reference_id = h.id
    AND a.household_id = h.id AND a.owner_id IS NULL AND h.avatar_path = a.legacy_path
    AND h.avatar_asset_id IS NULL RETURNING h.id
), pets AS (
  UPDATE public.pets p SET avatar_path = a.final_key, avatar_asset_id = a.id FROM assets a
  WHERE a.kind = 'pet' AND p.id = a.entity_id AND a.legacy_reference_id = p.id
    AND p.household_id = a.household_id AND p.owner_id = a.owner_id AND p.avatar_path = a.legacy_path
    AND p.avatar_asset_id IS NULL RETURNING p.id
)
SELECT jsonb_build_object('activated', (SELECT count(*) FROM assets), 'modeChanged',
  public.set_media_storage_mode(CASE WHEN (SELECT count(*) FROM assets) > 0
    AND (SELECT count(*) FROM assets) = (SELECT count(*) FROM photos) + (SELECT count(*) FROM profiles)
      + (SELECT count(*) FROM households) + (SELECT count(*) FROM pets)
    THEN 'gcs' ELSE 'invalid' END)) AS result`;

export const CANCEL_STAGED_SQL = `WITH
mode_lock AS MATERIALIZED (SELECT mode FROM public.media_storage_state WHERE singleton FOR UPDATE),
live AS (${MIGRATION_SNAPSHOT_SQL}),
guard AS MATERIALIZED (SELECT 1 / ((public.media_is_operator() AND (SELECT mode FROM mode_lock) = 'frozen'
  AND ${normalizedSnapshotSql("(SELECT migration_snapshot FROM live)")} = $1::jsonb)::int) AS ok),
cancelled AS (UPDATE public.media_assets a SET state = 'deleted', deleted_at = now() FROM guard
  WHERE guard.ok = 1 AND a.is_legacy AND a.state = 'ready' RETURNING a.id)
SELECT jsonb_build_object('rolledBack', (SELECT count(*) FROM cancelled), 'modeChanged',
  public.set_media_storage_mode(CASE WHEN (SELECT count(*) FROM cancelled) > 0
    AND (SELECT count(*) FROM cancelled) = jsonb_array_length($1::jsonb->'references')
    THEN 'supabase' ELSE 'invalid' END)) AS result`;

export const ROLLBACK_MIGRATION_SQL = `WITH
mode_lock AS MATERIALIZED (SELECT mode FROM public.media_storage_state WHERE singleton FOR UPDATE),
live AS (${MIGRATION_SNAPSHOT_SQL}),
guard AS MATERIALIZED (SELECT 1 / ((public.media_is_operator() AND (SELECT mode FROM mode_lock) = 'frozen'
  AND ${normalizedSnapshotSql("(SELECT migration_snapshot FROM live)")} = $1::jsonb)::int) AS ok),
assets AS MATERIALIZED (SELECT a.* FROM public.media_assets a CROSS JOIN guard
  WHERE guard.ok = 1 AND a.is_legacy AND a.state = 'ready'),
photos AS (
  UPDATE public.record_photos p SET storage_path = a.legacy_path, media_asset_id = NULL
  FROM assets a, public.daycare_records r WHERE a.kind = 'photo' AND p.id = a.legacy_reference_id
    AND p.record_id = a.entity_id AND r.id = p.record_id AND r.household_id = a.household_id
    AND r.owner_id = a.owner_id AND p.household_id = a.household_id AND p.storage_path = a.final_key
    AND p.media_asset_id = a.id RETURNING p.id
), profiles AS (
  UPDATE public.profiles p SET avatar_path = a.legacy_path, avatar_asset_id = NULL FROM assets a
  WHERE a.kind = 'profile' AND p.owner_id = a.entity_id AND p.owner_id = a.legacy_reference_id
    AND p.avatar_path = a.final_key AND p.avatar_asset_id = a.id RETURNING p.owner_id
), households AS (
  UPDATE public.households h SET avatar_path = a.legacy_path, avatar_asset_id = NULL FROM assets a
  WHERE a.kind = 'household' AND h.id = a.entity_id AND h.id = a.legacy_reference_id
    AND h.avatar_path = a.final_key AND h.avatar_asset_id = a.id RETURNING h.id
), pets AS (
  UPDATE public.pets p SET avatar_path = a.legacy_path, avatar_asset_id = NULL FROM assets a
  WHERE a.kind = 'pet' AND p.id = a.entity_id AND p.id = a.legacy_reference_id
    AND p.household_id = a.household_id AND p.owner_id = a.owner_id
    AND p.avatar_path = a.final_key AND p.avatar_asset_id = a.id RETURNING p.id
)
SELECT jsonb_build_object('rolledBack', (SELECT count(*) FROM assets), 'modeChanged',
  public.set_media_storage_mode(CASE WHEN (SELECT count(*) FROM assets) > 0
    AND (SELECT count(*) FROM assets) = (SELECT count(*) FROM photos) + (SELECT count(*) FROM profiles)
      + (SELECT count(*) FROM households) + (SELECT count(*) FROM pets)
    THEN 'supabase' ELSE 'invalid' END)) AS result`;
