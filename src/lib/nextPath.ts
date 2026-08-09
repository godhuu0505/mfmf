// ログイン後に戻る先（deep link）の受け渡し。
//
// 招待リンク（/invite/{token}）のように「未ログインで開かれる前提の URL」は、
// middleware がログイン画面へ飛ばした時点で行き先を失う。行き先は 2 経路で運ぶ:
//   - /login?next=... : メール/パスワードログイン（クライアントで完結する）用
//   - Cookie          : Google OAuth 用。Supabase の Redirect URLs は *完全一致* の
//                       許可リストなので、redirectTo に動的な ?next= を足すと
//                       許可リストから外れてログイン自体が壊れる。
export const POST_LOGIN_NEXT_COOKIE = "mfmf-post-login-next";

/** Cookie の寿命（秒）。ログインを終えるまでの数分だけ持てばよい。 */
export const POST_LOGIN_NEXT_MAX_AGE = 10 * 60;

// オープンリダイレクト防止: 自サイト内の絶対パスだけを許可する。
// 弾く例: "https://evil.example"（別オリジン）, "//evil.example"（プロトコル相対）,
// "/\evil.example"（ブラウザによっては // と解釈される）, 制御文字入り。
export function sanitizeNextPath(
  raw: string | null | undefined,
  fallback = "/",
): string {
  if (!raw) return fallback;
  if (!raw.startsWith("/")) return fallback;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return fallback;
  return raw;
}
