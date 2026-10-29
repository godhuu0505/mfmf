import { z } from "zod";
import { getIdentityProtocol } from "@/lib/identity/server";
import { getMcpBrowserContext } from "@/lib/mcp/identity";
import { consentAuthorization, loadAuthorization, oauthErrorResponse } from "@/lib/mcp/oauth";
import { json, McpHttpError, readJson } from "@/lib/mcp/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const input = z.strictObject({ transactionId: z.string().regex(/^[\w-]{43}$/u), householdId: z.uuid().optional(), approved: z.boolean() });
export async function GET(request: Request) {
  try {
    const transactionId = new URL(request.url).searchParams.get("transactionId") ?? "";
    const [authorization, context] = await Promise.all([loadAuthorization(transactionId), getMcpBrowserContext()]);
    if (!context) throw new McpHttpError("UNAUTHENTICATED", 401, "ログインしてください。");
    if (!authorization) throw new McpHttpError("NOT_FOUND", 404, "接続を最初からやり直してください。");
    return json({ transactionId, ...authorization, eligibleHouseholds: context.households, csrfToken: (await getIdentityProtocol()).csrfToken() });
  } catch (error) { return oauthErrorResponse(error); }
}
export async function POST(request: Request) {
  try {
    const protocol = await getIdentityProtocol();
    if (!protocol.allowsMutation(request)) throw new McpHttpError("FORBIDDEN", 403, "接続を最初からやり直してください。");
    const context = await getMcpBrowserContext();
    if (!context) throw new McpHttpError("UNAUTHENTICATED", 401, "ログインしてください。");
    const body = input.parse(await readJson(request));
    if (body.approved && !context.households.some(household => household.householdId === body.householdId)) throw new McpHttpError("FORBIDDEN", 403, "選択した家族へのアクセス権がありません。");
    return json({ redirectTo: await consentAuthorization(body.transactionId, { subject: context.subject, userId: context.userId, householdId: body.householdId ?? "" }, body.approved) });
  } catch (error) { return oauthErrorResponse(error); }
}
