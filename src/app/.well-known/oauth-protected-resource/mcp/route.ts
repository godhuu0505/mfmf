import {
  MCP_SCOPE,
  mcpOrigin,
  mcpResource,
  oauthErrorResponse,
} from "@/lib/mcp/oauth";
import { json } from "@/lib/mcp/http";
export const dynamic = "force-dynamic";
export function GET() {
  try {
    return json({
      resource: mcpResource(),
      authorization_servers: [mcpOrigin()],
      scopes_supported: [MCP_SCOPE],
      bearer_methods_supported: ["header"],
      resource_name: "mfmf 読み取り専用",
    });
  } catch (error) {
    return oauthErrorResponse(error);
  }
}
