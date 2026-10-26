import { canonical, exact, requireValue } from "./storage-backup-format.mjs";
import { bindingFor, finalKey, UUID, isGeneration } from "./storage-migration-gcs.mjs";

export const EXPIRE_RESERVATIONS_SQL = `WITH expired AS (
  UPDATE public.media_assets SET state = 'deleted', deleted_at = now()
  WHERE public.media_is_operator() AND state = 'reserved' AND expires_at <= now() RETURNING id
) SELECT count(*)::int AS expired, 1 / (public.media_is_operator()::int) AS guard FROM expired`;
export const DELETED_ASSETS_SQL = `SELECT id,kind,entity_id AS "entityId",household_id AS "householdId",
  owner_id AS "ownerId",incoming_key AS "incomingKey",final_key AS "finalKey",generation
  FROM public.media_assets WHERE public.media_is_operator() AND state = 'deleted'
  AND ($1::uuid IS NULL OR id > $1::uuid) ORDER BY id LIMIT 200`;

export async function cleanupStorage({ query, gcs }) {
  // Terminal state is committed first. A failed GCS delete never revives access.
  const expired = await query(EXPIRE_RESERVATIONS_SQL, { write: true });
  requireValue(expired?.length === 1 && expired[0].guard === 1 && Number.isSafeInteger(expired[0].expired) && expired[0].expired >= 0);
  const result = { operation: "storage-cleanup", expiredReservations: expired[0].expired, checkedAssets: 0, deletedGenerations: 0, absentObjects: 0, failures: 0 };
  let cursor = null;
  for (;;) {
    const rows = await query(DELETED_ASSETS_SQL, { parameters: [cursor] });
    requireValue(Array.isArray(rows) && rows.length <= 200);
    if (!rows.length) break;
    for (const asset of rows) {
      exact(asset, ["id", "kind", "entityId", "householdId", "ownerId", "incomingKey", "finalKey", "generation"]);
      requireValue(UUID.test(asset.id) && (cursor === null || asset.id > cursor));
      requireValue(asset.incomingKey === `_incoming/${asset.id}` && asset.finalKey === finalKey(asset));
      requireValue(asset.generation === null || isGeneration(asset.generation));
      requireValue(++result.checkedAssets <= 10000);
      const bucket = asset.kind === "photo" ? "photos" : "avatars";
      try {
        const final = await gcs.stat(bucket, asset.finalKey, undefined, true);
        if (final) {
          requireValue(asset.generation === null || final.generation === asset.generation);
          requireValue(canonical(final.metadata) === canonical(bindingFor(asset, final.metadata?.["mfmf-source-generation"])));
          await gcs.remove(bucket, asset.finalKey, final.generation); result.deletedGenerations++;
        } else result.absentObjects++;
        const incoming = await gcs.stat(bucket, asset.incomingKey, undefined, true);
        if (incoming) { await gcs.remove(bucket, asset.incomingKey, incoming.generation); result.deletedGenerations++; }
        else result.absentObjects++;
      } catch { result.failures++; }
      cursor = asset.id;
    }
    if (rows.length < 200) break;
  }
  return result;
}
