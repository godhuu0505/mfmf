import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    // 以下を除く全ルートに適用:
    // - _next/static, _next/image, favicon, 画像/アイコン等の静的ファイル
    // - sw.js: Service Worker 本体。認証リダイレクトの対象にすると未ログイン時に
    //   text/html が返って登録・更新チェックが SecurityError で失敗する
    //   （E2E のオフラインフォールバック検証で発覚）
    "/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|sw.js|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
