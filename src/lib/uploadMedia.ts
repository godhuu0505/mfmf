"use client";

import { beginMediaUpload, cancelMediaUploads } from "@/app/(app)/media/actions";
import { createClient } from "@/lib/supabase/client";
import { buildAvatarPath, buildStoragePath } from "@/lib/storagePath";
import { AVATAR_BUCKET, PHOTO_BUCKET } from "@/types/database";
import type { MediaTarget } from "@/lib/mediaStorage";

export type UploadedMedia = { backend: "supabase"; path: string; bucket: string } | { backend: "gcs"; assetId: string };

export async function uploadMedia(target: MediaTarget, scopeId: string, file: File): Promise<UploadedMedia> {
  const prepared = await beginMediaUpload(target, file.size, file.type);
  if (prepared.backend === "supabase") {
    const path = target.kind === "photo" ? buildStoragePath(scopeId, target.entityId, file.name) : buildAvatarPath(scopeId, file.name);
    const bucket = target.kind === "photo" ? PHOTO_BUCKET : AVATAR_BUCKET;
    const { error } = await createClient().storage.from(bucket).upload(path, file, { contentType: file.type, upsert: false });
    if (error) throw new Error("画像を送信できませんでした。再読み込みしてお試しください");
    return { backend: "supabase", path, bucket };
  }
  try {
    const response = await fetch(prepared.url, { method: "PUT", headers: prepared.headers, body: file,
      credentials: "omit", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error();
    return { backend: "gcs", assetId: prepared.assetId };
  } catch {
    await cancelMediaUploads([prepared.assetId]).catch(() => {});
    throw new Error("画像を送信できませんでした。通信状態を確認してお試しください");
  }
}

export async function cancelUploadedMedia(uploads: UploadedMedia[]): Promise<void> {
  const ids = uploads.flatMap((upload) => upload.backend === "gcs" ? [upload.assetId] : []);
  if (ids.length) await cancelMediaUploads(ids);
  const supabase = createClient();
  for (const bucket of [PHOTO_BUCKET, AVATAR_BUCKET]) {
    const paths = uploads.flatMap((upload) => upload.backend === "supabase" && upload.bucket === bucket ? [upload.path] : []);
    if (paths.length) {
      const { error } = await supabase.storage.from(bucket).remove(paths);
      if (error) throw new Error("未保存の画像を取り消せませんでした");
    }
  }
}
