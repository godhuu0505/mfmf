import { NextResponse, type NextRequest } from "next/server";
import {
  POST_LOGIN_NEXT_COOKIE,
  POST_LOGIN_NEXT_MAX_AGE,
  sanitizeNextPath,
} from "@/lib/nextPath";

// ログイン後の戻り先 Cookie を貼り直す（延長する）だけの公開エンドポイント。
//
// なぜ Server Action ではなく Route Handler なのか:
//   Server Action は冒頭で必ず `getUser()` する規約（AGENTS.md）だが、この処理は
//   **ログイン前に走るのが正常**（確認メール / 再設定メールを頼む時点）。規約の
//   例外を作るより、認証系の公開経路として Route Handler に置く
//   （`auth/signout` と同じ扱い / CLAUDE.md の API Route 例外）。
//
// なぜ必要か:
//   招待リンク → ログイン →「新規登録」/「パスワードをお忘れの方」と回ると、
//   戻り先は Cookie にしか残らない（メール内リンクの redirectTo は Supabase の
//   Redirect URLs が完全一致の許可リストなので固定）。Cookie の寿命は招待を
//   開いた時点から数え始めるため、ログイン画面で迷った時間のぶんだけ、まだ有効な
//   メール内リンクより先に戻り先が切れてしまう。ここで貼り直すと寿命の起点が
//   「メールを頼んだ時刻」になり otp_expiry と揃う。
//
// 書き込むのはサニタイズ済みのサイト内パスだけ。念のため同一オリジンからの
// POST に限定する（他サイトから戻り先を仕込まれないように）。
export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return new NextResponse(null, { status: 403 });
  }

  const form = await request.formData().catch(() => null);
  const next = sanitizeNextPath(form?.get("next")?.toString());

  const response = new NextResponse(null, { status: 204 });
  if (next !== "/") {
    response.cookies.set(POST_LOGIN_NEXT_COOKIE, next, {
      path: "/",
      maxAge: POST_LOGIN_NEXT_MAX_AGE,
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    });
  }
  return response;
}
