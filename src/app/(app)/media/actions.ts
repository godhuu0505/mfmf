"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createGcsStorage, type GcsContentType } from "@/lib/gcsStorage";
import { cleanupDeletedMedia, parseMediaAsset, requireMediaWrites, type MediaTarget } from "@/lib/mediaStorage";

export async function beginMediaUpload(target: MediaTarget, byteSize: number, contentType: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const mode = await requireMediaWrites();
  if (mode === "supabase") return { backend: "supabase" as const };
  if (!target || !["photo", "profile", "household", "pet"].includes(target.kind) ||
      !Number.isSafeInteger(byteSize) || byteSize < 1 || byteSize > (target.kind === "photo" ? 10 : 2) * 1024 * 1024 ||
      !["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"].includes(contentType)) {
    throw new Error("JPEG・PNG・GIF・WebP・AVIF形式で、写真は10MB、アバターは2MB以内の画像を選んでください");
  }
  const { data, error } = await supabase.rpc("reserve_media_upload", { p_kind: target.kind, p_entity_id: target.entityId,
    p_household_id: target.householdId, p_byte_size: byteSize, p_content_type: contentType });
  if (error) throw new Error("画像の送信を開始できません。権限・保存容量を確認し、時間をおいてお試しください");
  const asset = parseMediaAsset(data);
  if (asset.created_by !== user.id || asset.state !== "reserved" || asset.kind !== target.kind ||
      asset.entity_id !== target.entityId || asset.household_id !== target.householdId ||
      asset.byte_size !== byteSize || asset.content_type !== contentType) throw new Error("画像の送信先を確認できませんでした");
  const signed = await createGcsStorage().signUpload({ bucket: asset.kind === "photo" ? "photos" : "avatars",
    name: asset.incoming_key, size: asset.byte_size, contentType: contentType as GcsContentType });
  return { backend: "gcs" as const, assetId: asset.id, ...signed };
}

export async function cancelMediaUploads(ids: string[]) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  if (!Array.isArray(ids) || ids.length > 20 || ids.some((id) => typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id))) {
    throw new Error("不正な画像の取消要求です");
  }
  for (const id of new Set(ids)) {
    const { data, error } = await supabase.rpc("cancel_media_upload", { p_asset_id: id });
    if (error) throw new Error("画像の送信を取り消せませんでした");
    const asset = parseMediaAsset(data);
    if (asset.id !== id || asset.created_by !== user.id || asset.state !== "deleted") throw new Error("画像の送信を取り消せませんでした");
    await cleanupDeletedMedia(asset);
  }
}
