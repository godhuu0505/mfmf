import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { siteRedirect } from "@/lib/siteRedirect";
import { isGcpAuthEnabled } from "@/lib/identity/config";
import {
  POST_LOGIN_NEXT_COOKIE,
  POST_LOGIN_NEXT_MAX_AGE,
  sanitizeNextPath,
  withNext,
} from "@/lib/nextPath";

export async function POST(request: NextRequest) {
  if (isGcpAuthEnabled()) {
    try {
      const { getIdentityProtocol } = await import("@/lib/identity/server");
      const protocol = await getIdentityProtocol();
      if (!protocol.allowsOrigin(request)) return new NextResponse(null, { status: 403 });
      await protocol.signout();
    } catch { return new NextResponse("ログアウトを完了できませんでした。再度お試しください。", { status: 503, headers: { "Cache-Control": "no-store" } }); }
  } else {
    const supabase = await createClient();
    await supabase.auth.signOut();
  }

  // 「別のアカウントでログインし直す」導線（招待の宛先違いなど）から呼ばれたときは、
  // ログイン後に元の画面へ戻す。行き先が無ければ従来どおり /login まで。
  const form = await request.formData().catch(() => null);
  const next = sanitizeNextPath(form?.get("next")?.toString());

  const response = siteRedirect(withNext("/login", next), 303);
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
