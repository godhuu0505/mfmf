import { NextResponse, type NextRequest } from "next/server";
import { getIdentityProtocol } from "@/lib/identity/server";
import { isGcpAuthEnabled } from "@/lib/identity/config";
import { siteRedirect } from "@/lib/siteRedirect";
import { POST_LOGIN_NEXT_COOKIE, sanitizeNextPath, withNext } from "@/lib/nextPath";

export const runtime = "nodejs";
const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };

// Google hosts email verification and password-reset forms. This endpoint does
// not consume action codes, state, query destinations, or user-supplied tokens.
export async function GET(request: NextRequest) {
  if (!isGcpAuthEnabled()) return new NextResponse(null, { status: 404, headers });
  const next = sanitizeNextPath(request.cookies.get(POST_LOGIN_NEXT_COOKIE)?.value);
  try {
    const verified = await (await getIdentityProtocol()).continueEmail();
    const response = siteRedirect(verified ? next : withNext("/login", next));
    for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
    return response;
  } catch {
    return new NextResponse("認証を確認できません。時間をおいて再度お試しください。", { status: 503, headers });
  }
}
