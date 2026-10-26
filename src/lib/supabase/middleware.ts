import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { SUPABASE_AUTH_COOKIE } from "./cookieName";
import { siteRelativeLocation } from "@/lib/siteRedirect";
import {
  POST_LOGIN_NEXT_COOKIE,
  POST_LOGIN_NEXT_MAX_AGE,
  sanitizeNextPath,
  withNext,
} from "@/lib/nextPath";

// 認証セッションを更新し、未ログインなら /login へリダイレクトする。
export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.SUPABASE_INTERNAL_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: { name: SUPABASE_AUTH_COOKIE },
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // getUser() を呼ぶことでトークンをリフレッシュする (重要)
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  // Web Vitals はログイン画面からも送られる。ページ離脱時の
  // Beacon を /login へ飛ばすと、OAuth 直前の戻り先が /api/vitals に
  // 上書きされる。未認証の計測は body を読まず 204 で破棄し、匿名の
  // 入力を Sentry へ転送しない。認証済みでも回復中の Cookie を消費させない。
  if (pathname === "/api/vitals") {
    return user ? supabaseResponse : new NextResponse(null, { status: 204 });
  }

  // ログイン済みユーザーには不要な認証系ページ（/login・/signup）
  const isAuthRoute =
    pathname.startsWith("/login") || pathname.startsWith("/signup");
  // 認証不要で到達するルート:
  // - /offline: オフライン用フォールバック
  // - /auth/*: OAuth コールバック等（セッション確立前に到達する）
  // - /share/*: 読み取り専用の共有ビュー（共有「管理」画面 /shares は保護対象）
  // - /signup, /forgot-password: セルフ登録（UC-O02）・パスワード再設定の入口
  //   （/reset-password は回復セッション確立後に到達するため保護対象のまま）
  // - /terms, /privacy: 利用規約・プライバシーポリシー（サインアップ前に閲覧する）
  const isPublicRoute =
    pathname === "/offline" ||
    pathname.startsWith("/auth") ||
    pathname.startsWith("/share/") ||
    pathname.startsWith("/signup") ||
    pathname.startsWith("/forgot-password") ||
    pathname === "/terms" ||
    pathname === "/privacy";

  if (!user && !isAuthRoute && !isPublicRoute) {
    // 未ログイン → /login へ。招待リンク（/invite/{token}）のような deep link を
    // ログインで失わないよう、行き先を ?next= と Cookie の両方で持ち回る
    // （Cookie が必要な理由は src/lib/nextPath.ts のコメント参照）。
    const next = sanitizeNextPath(`${pathname}${request.nextUrl.search}`);
    // middleware adapter は絶対Locationを要求し、同originなら配信時に相対化する。
    // Route Handler と違い、ここは adapter が持つ request URL を基底に保つ。
    const redirectResponse = NextResponse.redirect(new URL(withNext("/login", next), request.url));
    supabaseResponse.cookies.getAll().forEach((cookie) => redirectResponse.cookies.set(cookie));
    if (next !== "/") {
      redirectResponse.cookies.set(POST_LOGIN_NEXT_COOKIE, next, {
        path: "/",
        maxAge: POST_LOGIN_NEXT_MAX_AGE,
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
      });
    }
    return redirectResponse;
  }

  if (user && isAuthRoute) {
    // ログイン済みで /login に来たら、指定があればその行き先へ（なければ一覧へ）
    const next = sanitizeNextPath(request.nextUrl.searchParams.get("next"));
    const response = NextResponse.redirect(new URL(siteRelativeLocation(next), request.url));
    supabaseResponse.cookies.getAll().forEach((cookie) => response.cookies.set(cookie));
    return response;
  }

  // ログイン済みのユーザーに戻り先 Cookie が残っていたら、ここで使い切る。
  // メール/パスワードログインは ?next= だけを見てクライアントで遷移するため、
  // 消さないと Cookie が最大 10 分残り、その間に別アカウントで Google OAuth を
  // 始めると /auth/callback が古い行き先（前の招待）へ飛ばしてしまう。
  // /auth/* は callback 自身が、/reset-password は更新後の行き先として
  // Cookie を読むので触らない（回復セッションで到達＝ログイン済みになる）。
  if (
    user &&
    !pathname.startsWith("/auth") &&
    pathname !== "/reset-password" &&
    request.cookies.has(POST_LOGIN_NEXT_COOKIE)
  ) {
    supabaseResponse.cookies.delete(POST_LOGIN_NEXT_COOKIE);
  }

  return supabaseResponse;
}
