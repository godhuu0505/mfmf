import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { saveGoogleRefreshToken } from "@/lib/google/token";
import { POST_LOGIN_NEXT_COOKIE, sanitizeNextPath } from "@/lib/nextPath";

// Google OAuth のコールバック。認可コードをセッションへ交換し、
// 初回同意で得られる refresh token を暗号化保存する。
// （CLAUDE.md の「API Route は基本作らない」例外。OAuth コールバックは Route Handler 必須）
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
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

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=oauth`);
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.session) {
    return NextResponse.redirect(`${origin}/login?error=oauth`);
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
      return NextResponse.redirect(`${origin}/login?error=drive`);
    }
  }

  const response = NextResponse.redirect(`${origin}${next}`);
  if (consumedCookie) response.cookies.delete(POST_LOGIN_NEXT_COOKIE);
  return response;
}
