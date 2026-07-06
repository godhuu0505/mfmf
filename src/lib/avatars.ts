import { createClient } from "@/lib/supabase/server";
import { AVATAR_BUCKET } from "@/types/database";
import { toBrowserUrl } from "@/lib/photos";

const SIGNED_URL_TTL = 60 * 60; // 1時間（record_photos と揃える）

// private な avatars バケットのアバターに署名付き URL（ブラウザ到達可能な形）を付与する。
// path が null の場合は null を返す（未設定アバター）。
export async function createAvatarSignedUrl(
  path: string | null | undefined,
  ttlSeconds: number = SIGNED_URL_TTL,
): Promise<string | null> {
  if (!path) return null;
  const supabase = await createClient();
  const { data } = await supabase.storage
    .from(AVATAR_BUCKET)
    .createSignedUrl(path, ttlSeconds);
  return data?.signedUrl ? toBrowserUrl(data.signedUrl) : null;
}

// 複数パスの署名付き URL を path -> url の Map でまとめて返す（一覧表示用）。
export async function createAvatarSignedUrls(
  paths: string[],
  ttlSeconds: number = SIGNED_URL_TTL,
): Promise<Map<string, string>> {
  const uniquePaths = Array.from(new Set(paths.filter((p): p is string => Boolean(p))));
  if (uniquePaths.length === 0) return new Map();
  const supabase = await createClient();
  const { data } = await supabase.storage
    .from(AVATAR_BUCKET)
    .createSignedUrls(uniquePaths, ttlSeconds);

  const map = new Map<string, string>();
  data?.forEach((s) => {
    if (s.path && s.signedUrl) map.set(s.path, toBrowserUrl(s.signedUrl));
  });
  return map;
}
