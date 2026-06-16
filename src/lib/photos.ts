import { createClient } from "@/lib/supabase/server";
import { PHOTO_BUCKET, type RecordPhoto } from "@/types/database";

const SIGNED_URL_TTL = 60 * 60; // 1時間

// private バケットの写真に署名付き URL を付与する。
export async function withSignedUrls(
  photos: RecordPhoto[],
): Promise<(RecordPhoto & { url: string | null })[]> {
  if (photos.length === 0) return [];

  const supabase = await createClient();
  const { data } = await supabase.storage
    .from(PHOTO_BUCKET)
    .createSignedUrls(
      photos.map((p) => p.storage_path),
      SIGNED_URL_TTL,
    );

  return photos.map((photo, i) => ({
    ...photo,
    url: data?.[i]?.signedUrl ?? null,
  }));
}
