import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { SUPABASE_AUTH_COOKIE } from "./cookieName";
import {
  POST_LOGIN_NEXT_COOKIE,
  POST_LOGIN_NEXT_MAX_AGE,
  sanitizeNextPath,
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
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    if (next !== "/") url.searchParams.set("next", next);
    const redirectResponse = NextResponse.redirect(url);
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
    return NextResponse.redirect(new URL(next, request.url));
  }

  return supabaseResponse;
}
