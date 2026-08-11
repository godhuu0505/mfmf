import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  POST_LOGIN_NEXT_COOKIE,
  POST_LOGIN_NEXT_MAX_AGE,
  sanitizeNextPath,
} from "@/lib/nextPath";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  await supabase.auth.signOut();

  // 「別のアカウントでログインし直す」導線（招待の宛先違いなど）から呼ばれたときは、
  // ログイン後に元の画面へ戻す。行き先が無ければ従来どおり /login まで。
  const form = await request.formData().catch(() => null);
  const next = sanitizeNextPath(form?.get("next")?.toString());

  const url = new URL("/login", request.url);
  if (next !== "/") url.searchParams.set("next", next);
  const response = NextResponse.redirect(url, { status: 303 });
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
