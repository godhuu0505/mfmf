import { startAuthorization, oauthErrorResponse } from "@/lib/mcp/oauth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const redirect = await startAuthorization(
      new URL(request.url).searchParams,
    );
    return new Response(null, {
      status: 302,
      headers: {
        Location: redirect,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch (error) {
    return oauthErrorResponse(error);
  }
}
