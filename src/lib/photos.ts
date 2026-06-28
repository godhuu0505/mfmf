import { createClient } from "@/lib/supabase/server";
import { PHOTO_BUCKET, type RecordPhoto } from "@/types/database";

const SIGNED_URL_TTL = 60 * 60; // 1時間

// just up（docker）で動かす場合、SSR は SUPABASE_INTERNAL_URL
// （例: http://host.docker.internal:54321）で Supabase に繋ぐ。
// createSignedUrls が返す URL はその接続先 URL を含むため、ブラウザから
// 直接到達できる NEXT_PUBLIC_SUPABASE_URL に書き換える必要がある。
// 署名はパス+クエリに対する HMAC なのでホスト差し替えは安全。
// just dev / 本番ではどちらの URL も一致するので no-op。
function toBrowserUrl(url: string): string {
  const internal = process.env.SUPABASE_INTERNAL_URL;
  const publicUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!internal || !publicUrl || internal === publicUrl) return url;
  if (url.startsWith(internal)) return publicUrl + url.slice(internal.length);
  return url;
}

// 指定パスの署名付き URL（ブラウザ到達可能な形）を path -> url の Map で返す。
export async function createPhotoSignedUrls(
  paths: string[],
  ttlSeconds: number = SIGNED_URL_TTL,
): Promise<Map<string, string>> {
  if (paths.length === 0) return new Map();
  const supabase = await createClient();
  const { data } = await supabase.storage
    .from(PHOTO_BUCKET)
    .createSignedUrls(paths, ttlSeconds);

  const map = new Map<string, string>();
  data?.forEach((s) => {
    if (s.path && s.signedUrl) map.set(s.path, toBrowserUrl(s.signedUrl));
  });
  return map;
}

// private バケットの写真に署名付き URL を付与する。
export async function withSignedUrls(
  photos: RecordPhoto[],
): Promise<(RecordPhoto & { url: string | null })[]> {
  if (photos.length === 0) return [];
  const urlByPath = await createPhotoSignedUrls(
    photos.map((p) => p.storage_path),
  );
  return photos.map((photo) => ({
    ...photo,
    url: urlByPath.get(photo.storage_path) ?? null,
  }));
}
