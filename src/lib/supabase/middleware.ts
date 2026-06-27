import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// 認証セッションを更新し、未ログインなら /login へリダイレクトする。
export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
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
  const isAuthRoute = pathname.startsWith("/login");
  // 認証不要で到達するルート:
  // - /offline: オフライン用フォールバック
  // - /auth/*: OAuth コールバック等（セッション確立前に到達する）
  // - /share/*: 読み取り専用の共有ビュー（共有「管理」画面 /shares は保護対象）
  const isPublicRoute =
    pathname === "/offline" ||
    pathname.startsWith("/auth") ||
    pathname.startsWith("/share/");

  if (!user && !isAuthRoute && !isPublicRoute) {
    // 未ログイン → /login へ
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  if (user && isAuthRoute) {
    // ログイン済みで /login に来たら一覧へ
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
