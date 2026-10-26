import "server-only";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { assertAuthorizedMediaDescriptor, type AuthorizedMediaDescriptor } from "@/lib/mediaAuthorization";
import { createGcsStorage, type GcsBinding, type GcsContentType, type GcsMetadata } from "@/lib/gcsStorage";

type ServerClient = Awaited<ReturnType<typeof createClient>>;
export type MediaKind = "photo" | "profile" | "household" | "pet";
export type MediaTarget = { kind: MediaKind; entityId: string; householdId: string | null };
export type MediaAsset = {
  id: string; kind: MediaKind; entity_id: string; household_id: string | null;
  owner_id: string | null; created_by: string | null; incoming_key: string; final_key: string;
  byte_size: number; content_type: GcsContentType; state: "reserved" | "ready" | "deleted";
  expires_at: string; generation: string | null; is_legacy: boolean;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MIME = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"];
const FAILURE = "画像の保存先を確認できませんでした。時間をおいて再度お試しください";
const gcs = createGcsStorage();
const objectValue = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

// This public configuration contains no credential. The database also enforces
// the mode for direct REST/Storage clients, including previously loaded pages.
export const getMediaStorageMode = cache(async (): Promise<"supabase" | "frozen" | "gcs"> => {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_media_storage_mode");
  if (error || !["supabase", "frozen", "gcs"].includes(data)) throw new Error(FAILURE);
  return data;
});
export async function requireMediaWrites(): Promise<"supabase" | "gcs"> {
  const mode = await getMediaStorageMode();
  if (mode === "frozen") throw new Error("画像の保存先を切り替えています。少し待ってから保存してください");
  return mode;
}

export function parseMediaAsset(value: unknown): MediaAsset {
  if (!objectValue(value) || !isUuid(value.id) || !isUuid(value.entity_id) || (value.is_legacy ? value.created_by !== null : !isUuid(value.created_by)) ||
      !["photo", "profile", "household", "pet"].includes(String(value.kind)) ||
      !["reserved", "ready", "deleted"].includes(String(value.state)) ||
      typeof value.is_legacy !== "boolean" || typeof value.expires_at !== "string" || !Number.isFinite(Date.parse(value.expires_at)) ||
      (value.kind === "household" ? value.owner_id !== null : !isUuid(value.owner_id)) ||
      (value.kind === "profile" ? value.household_id !== null || value.owner_id !== value.entity_id : !isUuid(value.household_id)) ||
      (value.kind === "household" && value.entity_id !== value.household_id) ||
      !Number.isSafeInteger(value.byte_size) || Number(value.byte_size) < 1 ||
      typeof value.content_type !== "string" || !MIME.includes(value.content_type) ||
      value.incoming_key !== `_incoming/${value.id}` ||
      typeof value.final_key !== "string" ||
      (value.generation !== null && (typeof value.generation !== "string" || !/^[1-9][0-9]{0,19}$/.test(value.generation)))) throw new Error(FAILURE);
  const scope = value.kind === "profile" ? value.owner_id : value.household_id;
  const prefix = `${scope}/${value.kind === "photo" ? value.entity_id : "avatars"}/`;
  if (!value.final_key.startsWith(prefix) || value.final_key.slice(prefix.length).includes("/") ||
      (!value.is_legacy && value.final_key !== `${prefix}${value.id}`)) throw new Error(FAILURE);
  return {
    id: value.id, kind: value.kind as MediaKind, entity_id: value.entity_id,
    household_id: value.household_id as string | null, owner_id: value.owner_id as string | null,
    created_by: value.created_by as string | null, incoming_key: value.incoming_key, final_key: value.final_key,
    byte_size: Number(value.byte_size), content_type: value.content_type as GcsContentType,
    state: value.state as MediaAsset["state"], expires_at: value.expires_at,
    generation: value.generation as string | null, is_legacy: value.is_legacy,
  };
}
export async function getMediaAsset(supabase: ServerClient, id: string): Promise<MediaAsset> {
  if (!isUuid(id)) throw new Error(FAILURE);
  const { data, error } = await supabase.rpc("get_media_upload", { p_asset_id: id });
  if (error) throw new Error(FAILURE);
  const asset = parseMediaAsset(data);
  if (asset.id !== id) throw new Error(FAILURE);
  return asset;
}
const bucket = (asset: MediaAsset) => asset.kind === "photo" ? "photos" as const : "avatars" as const;
const bindingKind = (kind: MediaKind): GcsBinding["kind"] => kind === "photo" ? "record-photo" : `${kind}-avatar`;
function bindingFor(asset: MediaAsset, sourceGeneration: string): GcsBinding {
  return { schema: "1", state: "ready", kind: bindingKind(asset.kind), entityId: asset.entity_id,
    householdId: asset.household_id, ownerId: asset.owner_id, reservationId: asset.id, sourceGeneration };
}
function checkMetadata(asset: MediaAsset, metadata: GcsMetadata | null): GcsMetadata {
  if (!metadata?.binding || metadata.name !== asset.final_key || metadata.bucket !== bucket(asset) ||
      metadata.size !== asset.byte_size || metadata.contentType !== asset.content_type ||
      (asset.generation && metadata.generation !== asset.generation)) throw new Error(FAILURE);
  const expected = bindingFor(asset, metadata.binding.sourceGeneration);
  for (const key of Object.keys(expected) as (keyof GcsBinding)[]) {
    if (metadata.binding[key] !== expected[key]) throw new Error(FAILURE);
  }
  return metadata;
}
function sameTarget(asset: MediaAsset, target: MediaTarget) {
  if (asset.kind !== target.kind || asset.entity_id !== target.entityId || asset.household_id !== target.householdId) throw new Error(FAILURE);
}

export async function signedGcsMediaUrl(descriptor: AuthorizedMediaDescriptor, ttl: number): Promise<string | null> {
  assertAuthorizedMediaDescriptor(descriptor);
  if (!descriptor.assetId) return null;
  const supabase = await createClient();
  const asset = await getMediaAsset(supabase, descriptor.assetId);
  sameTarget(asset, { kind: descriptor.kind, entityId: descriptor.kind === "photo" ? descriptor.recordId : descriptor.entityId, householdId: descriptor.householdId });
  if (asset.owner_id !== descriptor.ownerId || asset.final_key !== descriptor.path || asset.state !== "ready" || !asset.generation) return null;
  const metadata = await gcs.stat({ bucket: bucket(asset), name: asset.final_key, generation: asset.generation });
  if (!metadata) return null; // A definite 404 only. Never resurrect a deleted source copy.
  checkMetadata(asset, metadata);
  return gcs.signRead(metadata, ttl);
}

// Cleanup follows the database tombstone. A failed cleanup cannot restore a
// reference; the operator maintenance job can retry the same exact generation.
export async function cleanupDeletedMedia(asset: MediaAsset): Promise<void> {
  if (asset.state !== "deleted") throw new Error(FAILURE);
  const final = await gcs.stat({ bucket: bucket(asset), name: asset.final_key, ...(asset.generation ? { generation: asset.generation } : {}) });
  if (final) await gcs.deleteGeneration(checkMetadata(asset, final));
  const incoming = await gcs.stat({ bucket: bucket(asset), name: asset.incoming_key });
  if (incoming) await gcs.deleteGeneration(incoming);
}
async function cleanupRetired(value: unknown) {
  if (!Array.isArray(value) || value.length > 100) throw new Error(FAILURE);
  for (const raw of value) await cleanupDeletedMedia(parseMediaAsset(raw));
}

export async function finalizeMediaUpload(supabase: ServerClient, actorId: string, id: string, target: MediaTarget,
  expectedOld: { path: string | null; assetId: string | null } = { path: null, assetId: null }): Promise<void> {
  const asset = await getMediaAsset(supabase, id);
  sameTarget(asset, target);
  if (asset.created_by !== actorId || asset.state === "deleted") throw new Error("この画像のアップロードは利用できません");
  if (asset.state === "reserved" && Date.parse(asset.expires_at) <= Date.now()) throw new Error("画像のアップロード期限が切れました。画像を選び直してください");
  let final = await gcs.stat({ bucket: bucket(asset), name: asset.final_key, ...(asset.generation ? { generation: asset.generation } : {}) });
  if (final) final = checkMetadata(asset, final);
  else {
    if (asset.state !== "reserved") throw new Error(FAILURE);
    const incoming = await gcs.stat({ bucket: bucket(asset), name: asset.incoming_key });
    if (!incoming) throw new Error("画像の送信が完了していません。もう一度お試しください");
    final = await gcs.publish({ source: incoming, destinationName: asset.final_key,
      binding: bindingFor(asset, incoming.generation), expectedSize: asset.byte_size, contentType: asset.content_type });
  }
  // Re-read after the copy: the caller can cancel, lose its role or delete the
  // parent while GCS is processing. The transaction below performs the final CAS.
  const current = await getMediaAsset(supabase, id);
  if (current.state === "deleted") { await cleanupDeletedMedia(current); throw new Error("画像の保存が取り消されました"); }
  const { data, error } = await supabase.rpc("commit_media_upload", { p_asset_id: id, p_generation: final.generation,
    p_expected_old_path: expectedOld.path, p_expected_old_asset_id: expectedOld.assetId });
  if (error || !objectValue(data)) throw new Error("画像を登録できませんでした。保存済みの記録から再度お試しください");
  const committed = parseMediaAsset(data.asset);
  if (committed.id !== id || committed.state !== "ready" || committed.generation !== final.generation) throw new Error(FAILURE);
  await cleanupRetired(data.retired_assets);
  const incoming = await gcs.stat({ bucket: bucket(asset), name: asset.incoming_key });
  if (incoming) await gcs.deleteGeneration(incoming);
}

export async function deleteGcsMediaReference(supabase: ServerClient, target: MediaTarget,
  options: { photoId?: string; assetId: string | null; path: string | null }): Promise<void> {
  const { data, error } = await supabase.rpc("delete_media_reference", { p_kind: target.kind, p_entity_id: target.entityId,
    p_photo_id: options.photoId ?? null, p_expected_asset_id: options.assetId, p_expected_old_path: options.path });
  if (error || !objectValue(data)) throw new Error("画像を削除できませんでした。再読み込みしてお試しください");
  await cleanupRetired(data.retired_assets);
}

// Returns true after handling a GCS avatar operation. The target-specific Action
// must already have authenticated the user and checked its own editing role.
export async function handleGcsAvatar(supabase: ServerClient, actorId: string, target: MediaTarget,
  formData: FormData, current: { avatar_path: string | null; avatar_asset_id: string | null } | null): Promise<boolean> {
  const mode = await requireMediaWrites();
  const uploadId = String(formData.get("media_upload_id") ?? "");
  if (mode === "supabase") {
    if (uploadId) throw new Error("保存先が変わりました。再読み込みして画像を選び直してください");
    return false;
  }
  if (String(formData.get("avatar_path") ?? "") !== "") throw new Error("保存先が変わりました。再読み込みして画像を選び直してください");
  const expected = { path: current?.avatar_path ?? null, assetId: current?.avatar_asset_id ?? null };
  if (uploadId) await finalizeMediaUpload(supabase, actorId, uploadId, target, expected);
  else {
    if (!formData.has("avatar_path")) throw new Error("画像の変更内容がありません");
    await deleteGcsMediaReference(supabase, target, expected);
  }
  return true;
}

export async function signedGcsMediaUrls(descriptors: readonly AuthorizedMediaDescriptor[], ttl: number): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  let cursor = 0;
  // Bound provider/DB fan-out while keeping the 300-image gallery within the
  // request timeout. No object bytes are downloaded on the read path.
  await Promise.all(Array.from({ length: Math.min(8, descriptors.length) }, async () => {
    while (cursor < descriptors.length) {
      const media = descriptors[cursor++];
      const url = await signedGcsMediaUrl(media, ttl);
      if (url) urls.set(media.kind === "photo" ? media.photoId : `${media.kind}:${media.entityId}`, url);
    }
  }));
  return urls;
}
