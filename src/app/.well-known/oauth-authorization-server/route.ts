import {
  MCP_SCOPE,
  mcpOrigin,
  oauthErrorResponse,
} from "@/lib/mcp/oauth";
import { json } from "@/lib/mcp/http";
export const dynamic = "force-dynamic";
export function GET() {
  try {
    const issuer = mcpOrigin();
    return json({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: [
        "none",
        "client_secret_post",
        "client_secret_basic",
      ],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: [MCP_SCOPE],
      authorization_response_iss_parameter_supported: true,
    });
  } catch (error) {
    return oauthErrorResponse(error);
  }
}
