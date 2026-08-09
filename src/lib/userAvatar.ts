import type { User } from "@supabase/supabase-js";
import { createAvatarSignedUrl } from "@/lib/avatars";
import { createClient } from "@/lib/supabase/server";

// ユーザーのアイコン表示に必要な最小限のデータ。
// url が null のときは initial（頭文字）を出す、が画面側の共通ルール。
export type UserAvatarData = {
  /** 表示する画像 URL（アプリ内アバター > Google の画像）。無ければ null。 */
  url: string | null;
  /** 画像が無いときに出す頭文字（サロゲートペア対応・大文字化）。空文字もありうる。 */
  initial: string;
  /** 表示名（表示名 > メール）。 */
  label: string;
};

// Google（OAuth）プロフィール画像の URL を user_metadata から取り出す。
// Supabase は provider により avatar_url / picture のどちらかに入れるため両方見る。
// http(s) 以外（javascript: 等）は表示に使わない。
export function getOAuthAvatarUrl(user: User | null | undefined): string | null {
  const meta = user?.user_metadata as Record<string, unknown> | undefined;
  const candidates = [meta?.avatar_url, meta?.picture];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.trim() === "") continue;
    try {
      const url = new URL(candidate);
      if (url.protocol === "https:" || url.protocol === "http:") return candidate;
    } catch {
      // URL として不正なものは無視する
    }
  }
  return null;
}

// 表示名 / メールから頭文字を作る。絵文字や結合文字で壊れないよう Array.from で分解する。
export function getAvatarInitial(...sources: (string | null | undefined)[]): string {
  for (const source of sources) {
    const trimmed = (source ?? "").trim();
    if (!trimmed) continue;
    const first = Array.from(trimmed)[0];
    if (first) return first.toUpperCase();
  }
  return "";
}

// 画面共通のアイコン解決: アプリ内で設定したアバター > Google アカウントの画像 > 頭文字。
// profile を渡さない場合はここで profiles を 1 回引く。
export async function getUserAvatarData(
  user: User | null,
  profile?: { display_name: string | null; avatar_path: string | null } | null,
): Promise<UserAvatarData> {
  if (!user) return { url: null, initial: "", label: "" };

  let resolved = profile;
  if (resolved === undefined) {
    const supabase = await createClient();
    const { data } = await supabase
      .from("profiles")
      .select("display_name, avatar_path")
      .eq("owner_id", user.id)
      .maybeSingle();
    resolved = data as { display_name: string | null; avatar_path: string | null } | null;
  }

  // アップロード済みアバターは private バケットなので署名付き URL にする。
  // 署名に失敗した（オブジェクトが消えている等）ときは Google の画像に落とす。
  const uploadedUrl = await createAvatarSignedUrl(resolved?.avatar_path);

  return {
    url: uploadedUrl ?? getOAuthAvatarUrl(user),
    initial: getAvatarInitial(resolved?.display_name, user.email),
    label: resolved?.display_name || user.email || "アカウント",
  };
}
