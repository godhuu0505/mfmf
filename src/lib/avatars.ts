import { getMediaStorageMode, signedGcsMediaUrls } from "@/lib/mediaStorage";
import { createClient } from "@/lib/supabase/server";
import { AVATAR_BUCKET } from "@/types/database";
import { toBrowserUrl } from "@/lib/photos";
import { authorizeAvatarReads } from "@/lib/mediaAuthorization";

const SIGNED_URL_TTL = 60 * 60;

type AvatarTarget = { kind: "profile" | "household" | "pet"; entityId: string };

// パスではなく参照元の ID を受ける。RLS と対象世帯の所属、実際の保存パスを
// 毎回照合するため、別世帯のパスを自分の行へ書き込んでも署名できない。
export async function createAvatarSignedUrl(
  target: AvatarTarget | null,
  ttlSeconds: number = SIGNED_URL_TTL,
): Promise<string | null> {
  if (!target) return null;
  const urls = await createAvatarSignedUrls([target], ttlSeconds);
  return urls.get(`${target.kind}:${target.entityId}`) ?? null;
}

export async function createAvatarSignedUrls(
  targets: AvatarTarget[],
  ttlSeconds: number = SIGNED_URL_TTL,
): Promise<Map<string, string>> {
  if (targets.length === 0) return new Map();
  const avatars = await authorizeAvatarReads(targets);
  if (avatars.length === 0) return new Map();
  if (await getMediaStorageMode() === "gcs") {
    return signedGcsMediaUrls(avatars, ttlSeconds);
  }
  const supabase = await createClient();
  const { data, error } = await supabase.storage
    .from(AVATAR_BUCKET)
    .createSignedUrls([...new Set(avatars.map((avatar) => avatar.path))], ttlSeconds);
  if (error) throw new Error("アバターの表示を準備できませんでした");

  const urlByPath = new Map<string, string>();
  data?.forEach((s) => {
    if (s.path && s.signedUrl) urlByPath.set(s.path, toBrowserUrl(s.signedUrl));
  });
  const map = new Map<string, string>();
  for (const avatar of avatars) {
    const url = urlByPath.get(avatar.path);
    if (url) map.set(`${avatar.kind}:${avatar.entityId}`, url);
  }
  return map;
}
