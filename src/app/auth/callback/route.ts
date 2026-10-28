import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { saveGoogleRefreshToken } from "@/lib/google/token";
import { siteRedirect } from "@/lib/siteRedirect";
import { isGcpAuthEnabled } from "@/lib/identity/config";
import {
  POST_LOGIN_NEXT_COOKIE,
  callbackRetryNext,
  sanitizeNextPath,
  withNext,
} from "@/lib/nextPath";

// Google OAuth のコールバック。認可コードをセッションへ交換し、
// 初回同意で得られる refresh token を暗号化保存する。
// （CLAUDE.md の「API Route は基本作らない」例外。OAuth コールバックは Route Handler 必須）
export async function GET(request: NextRequest) {
  if (isGcpAuthEnabled()) {
    const { getIdentityProtocol } = await import("@/lib/identity/server");
    const { createGcpDataClient } = await import("@/lib/gcp/dataClient");
    const next = sanitizeNextPath(request.cookies.get(POST_LOGIN_NEXT_COOKIE)?.value);
    let protocol: Awaited<ReturnType<typeof getIdentityProtocol>> | undefined;
    let reason = "oauth";
    try {
      protocol = await getIdentityProtocol();
      const result = await protocol.finishGoogle(request.nextUrl.searchParams);
      const { client, user } = await createGcpDataClient(result.identity);
      if (!user) throw new Error();
      if (result.refreshToken) {
        reason = "drive";
        // The isolated migration candidate permits read-only sign-in while its
        // database is frozen. Keep the restored ciphertext in that state only.
        // The operator changes this mode and the full DB write gate atomically.
        const { data: mode, error } = await client.rpc("get_media_storage_mode");
        if (error || (mode !== "frozen" && mode !== "gcs")) throw new Error();
        if (mode === "gcs") await saveGoogleRefreshToken(client, user.id, result.refreshToken);
      }
      const response = siteRedirect(next);
      response.cookies.delete(POST_LOGIN_NEXT_COOKIE);
      response.headers.set("Cache-Control", "private, no-store");
      response.headers.set("Referrer-Policy", "no-referrer");
      return response;
    } catch {
      // Do not let middleware bypass the retry screen after a partial sign-in.
      protocol?.clearSession();
      const path = withNext("/login", next);
      const response = siteRedirect(`${path}${path.includes("?") ? "&" : "?"}error=${reason}`);
      response.headers.set("Cache-Control", "private, no-store");
      response.headers.set("Referrer-Policy", "no-referrer");
      return response;
    }
  }
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  // 戻り先は ?next=（パスワード再設定リンク等）を優先し、無ければ middleware が
  // 置いた Cookie を使う（Google OAuth は redirectTo が完全一致の許可リストのため
  // クエリを足せない / src/lib/nextPath.ts）。どちらもサイト内パスのみ許可する。
  const cookieNext = request.cookies.get(POST_LOGIN_NEXT_COOKIE)?.value;
  const queryNext = searchParams.get("next");
  const next = sanitizeNextPath(queryNext ?? cookieNext);
  // クエリが勝った（= パスワード再設定リンクなど、認証フローの途中）ときは
  // Cookie を消さない。招待リンク → ログイン →「パスワードをお忘れの方」と
  // 回った場合、元の招待は Cookie にしか残っていないため。
  const consumedCookie = !queryNext;

  // Google 同意の取消・コード交換失敗の後にメールログインへ切り替えても、
  // URL の next を読む LoginForm が元の招待を失わないようにする。
  function retryLogin(reason: "oauth" | "drive") {
    const path = withNext("/login", callbackRetryNext(queryNext, cookieNext));
    return siteRedirect(`${path}${path.includes("?") ? "&" : "?"}error=${reason}`);
  }

  if (!code) {
    return retryLogin("oauth");
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.session) {
    return retryLogin("oauth");
  }

  // access_type=offline + prompt=consent で毎回 refresh token が返る想定。
  // 万一返らない（同意済みで省略される）場合は既存の保存値を使い続ける。
  const refreshToken = data.session.provider_refresh_token;
  const userId = data.session.user.id;
  if (refreshToken) {
    try {
      await saveGoogleRefreshToken(supabase, userId, refreshToken);
    } catch (e) {
      console.error("failed to save google refresh token", e);
      return retryLogin("drive");
    }
  }

  const response = siteRedirect(next);
  if (consumedCookie) response.cookies.delete(POST_LOGIN_NEXT_COOKIE);
  return response;
}
