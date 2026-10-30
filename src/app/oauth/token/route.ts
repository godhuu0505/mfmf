import { exchangeToken, oauthErrorResponse } from "@/lib/mcp/oauth";
import { json } from "@/lib/mcp/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    return json(await exchangeToken(request));
  } catch (error) {
    return oauthErrorResponse(error);
  }
}
