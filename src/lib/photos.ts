import { createClient } from "@/lib/supabase/server";
import { PHOTO_BUCKET, type RecordPhoto } from "@/types/database";
import { authorizePhotoReads } from "@/lib/mediaAuthorization";

const SIGNED_URL_TTL = 60 * 60; // 1時間

// just up（docker）で動かす場合、SSR は SUPABASE_INTERNAL_URL
// （例: http://host.docker.internal:54321）で Supabase に繋ぐ。
// createSignedUrls が返す URL はその接続先 URL を含むため、ブラウザから
// 直接到達できる NEXT_PUBLIC_SUPABASE_URL に書き換える必要がある。
// 署名はパス+クエリに対する HMAC なのでホスト差し替えは安全。
// just dev / 本番ではどちらの URL も一致するので no-op。
export function toBrowserUrl(url: string): string {
  const internal = process.env.SUPABASE_INTERNAL_URL;
  const publicUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!internal || !publicUrl || internal === publicUrl) return url;
  if (url.startsWith(internal)) return publicUrl + url.slice(internal.length);
  return url;
}

// 写真行の ID から認可とパスの帰属を再確認し、ID -> URL を返す。
// 呼出元が取得した行や、クライアント申告のパスを署名権限として扱わない。
export async function createPhotoSignedUrls(
  photoIds: string[],
  ttlSeconds: number = SIGNED_URL_TTL,
): Promise<Map<string, string>> {
  if (photoIds.length === 0) return new Map();
  const photos = await authorizePhotoReads(photoIds);
  if (photos.length === 0) return new Map();
  const supabase = await createClient();
  const { data, error } = await supabase.storage
    .from(PHOTO_BUCKET)
    .createSignedUrls([...new Set(photos.map((photo) => photo.path))], ttlSeconds);
  if (error) throw new Error("写真の表示を準備できませんでした");

  const urlByPath = new Map<string, string>();
  data?.forEach((s) => {
    if (s.path && s.signedUrl) urlByPath.set(s.path, toBrowserUrl(s.signedUrl));
  });
  const map = new Map<string, string>();
  for (const photo of photos) {
    const url = urlByPath.get(photo.path);
    if (url) map.set(photo.photoId, url);
  }
  return map;
}

// private バケットの写真に署名付き URL を付与する。
export async function withSignedUrls(
  photos: RecordPhoto[],
): Promise<(RecordPhoto & { url: string | null })[]> {
  if (photos.length === 0) return [];
  const urlById = await createPhotoSignedUrls(
    photos.map((p) => p.id),
  );
  return photos.map((photo) => ({
    ...photo,
    url: urlById.get(photo.id) ?? null,
  }));
}
