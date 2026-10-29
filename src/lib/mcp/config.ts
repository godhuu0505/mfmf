import "server-only";
import { identityConfig } from "@/lib/identity/config";
import { McpHttpError } from "./http";

/** This app never accepts a project, database or origin from an MCP client. */
export function mcpConfiguration() {
  if (process.env.MCP_ENABLED !== "true") throw new McpHttpError("MCP_DISABLED", 503, "AIとの接続は準備中です。");
  const config = identityConfig();
  if (config.projectId !== "mfmf-499612") throw new McpHttpError("MCP_UNAVAILABLE", 503, "AIとの接続を確認できません。");
  return { origin: config.origin, projectId: config.projectId, databaseId: "mfmf-mcp" };
}
