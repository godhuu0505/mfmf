import { z } from "zod";
import { getIdentityProtocol } from "@/lib/identity/server";
import { getMcpBrowserContext } from "@/lib/mcp/identity";
import { listConnections, revokeConnection, oauthErrorResponse } from "@/lib/mcp/oauth";
import { json, McpHttpError, readJson } from "@/lib/mcp/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const context = await getMcpBrowserContext();
    if (!context) throw new McpHttpError("UNAUTHENTICATED", 401, "ログインしてください。");
    const connections = (await listConnections(context.userId)).map(({ householdId, ...connection }) => ({ ...connection,
      householdName: context.households.find(household => household.householdId === householdId)?.householdName ?? "以前接続した家族" }));
    return json({ connections, csrfToken: (await getIdentityProtocol()).csrfToken() });
  } catch (error) { return oauthErrorResponse(error); }
}
export async function DELETE(request: Request) {
  try {
    if (!(await getIdentityProtocol()).allowsMutation(request)) throw new McpHttpError("FORBIDDEN", 403, "操作を確認してください。");
    const context = await getMcpBrowserContext();
    if (!context) throw new McpHttpError("UNAUTHENTICATED", 401, "ログインしてください。");
    const { id } = z.strictObject({ id: z.string().regex(/^[\w-]{43}$/u) }).parse(await readJson(request));
    await revokeConnection(context.userId, id);
    return json({ revoked: true });
  } catch (error) { return oauthErrorResponse(error); }
}
