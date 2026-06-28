// PKCE / セッション Cookie の名前を固定する。
// @supabase/ssr は既定で `sb-${hostname.split(".")[0]}-auth-token` を導出するため、
// ブラウザ (NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 → "sb-127-...") と
// サーバ (SUPABASE_INTERNAL_URL=http://host.docker.internal:54321 → "sb-host-...") で
// Cookie 名が食い違い、PKCE の code-verifier を読み出せず OAuth が失敗する。
// クライアント/サーバ/middleware すべてでこの値を使えば storageKey が揃う。
export const SUPABASE_AUTH_COOKIE = "sb-mfmf-auth-token";
