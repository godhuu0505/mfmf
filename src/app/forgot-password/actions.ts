"use server";

import { cookies } from "next/headers";
import {
  POST_LOGIN_NEXT_COOKIE,
  POST_LOGIN_NEXT_MAX_AGE,
  sanitizeNextPath,
} from "@/lib/nextPath";

// 再設定メールを送る時点で、ログイン後の戻り先 Cookie を貼り直す（延長する）。
//
// 招待リンク → ログイン →「パスワードをお忘れの方」と回ると、戻り先は Cookie に
// しか残らない（再設定リンクの redirectTo は Supabase の Redirect URLs が完全一致の
// 許可リストなので ?next=/reset-password 固定）。Cookie の寿命は招待を開いた時点から
// 数え始めるため、ログイン画面で少し迷ってから再設定を頼むと、まだ有効な再設定
// リンクを開いても戻り先だけ先に切れている、ということが起きる。
// ここで貼り直すと、寿命の起点が「再設定を頼んだ時刻」になり otp_expiry と揃う。
export async function refreshPostLoginNext(next: string) {
  const safe = sanitizeNextPath(next);
  if (safe === "/") return;

  const cookieStore = await cookies();
  cookieStore.set(POST_LOGIN_NEXT_COOKIE, safe, {
    path: "/",
    maxAge: POST_LOGIN_NEXT_MAX_AGE,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
}
