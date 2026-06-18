import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptSecret, encryptSecret } from "./crypto";

// Google Drive 連携トークンの保存・発行ユーティリティ（サーバー専用）。
//
// - OAuth コールバックで得た refresh token を暗号化して google_credentials に保存
// - 保存済み refresh token から Drive 用の短命 access token を都度発行
//
// いずれも引数の Supabase クライアントはログイン中ユーザーのセッションを持つ前提。
// RLS により自分の行 (owner_id = auth.uid()) だけが対象になる。

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

// OAuth コールバックで得た refresh token を暗号化して保存（再ログイン時は上書き）。
export async function saveGoogleRefreshToken(
  supabase: SupabaseClient,
  ownerId: string,
  refreshToken: string,
): Promise<void> {
  const { error } = await supabase.from("google_credentials").upsert(
    {
      owner_id: ownerId,
      refresh_token_enc: encryptSecret(refreshToken),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "owner_id" },
  );
  if (error) throw error;
}

// 保存済み refresh token から Drive 用の access token を発行する。
// access token は短命のため都度発行し、保存しない。
export async function getGoogleAccessToken(
  supabase: SupabaseClient,
  ownerId: string,
): Promise<string> {
  const { data, error } = await supabase
    .from("google_credentials")
    .select("refresh_token_enc")
    .eq("owner_id", ownerId)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new Error("Google 連携が見つかりません。再ログインしてください。");
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET が設定されていません。",
    );
  }

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: decryptSecret(data.refresh_token_enc),
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    // refresh token 失効時（再同意取消など）は 400 が返る
    throw new Error(`Google アクセストークンの取得に失敗しました (${res.status})`);
  }

  const json = (await res.json()) as { access_token: string };
  return json.access_token;
}
