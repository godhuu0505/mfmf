// UC-O08: 公開前はセルフサインアップを feature flag で閉じておく。
// 環境変数 SIGNUP_ENABLED=true のときだけ /signup を開放する（サーバー専用値。
// クライアントへは Server Component の props として渡す）。
//
// 注意: この flag が閉じるのは「アプリの UI/導線」まで。Supabase Auth の API 自体は
// プロジェクト設定（Authentication > Providers > Email の signup 許可）で制御される
// ため、本番で完全に閉じるには Supabase 側の enable_signup も無効にしておくこと
// （ローカルは supabase/config.toml の [auth.email] enable_signup）。
export function isSignupEnabled(): boolean {
  return process.env.SIGNUP_ENABLED === "true";
}
