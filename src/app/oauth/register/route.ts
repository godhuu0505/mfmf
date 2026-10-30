import { NextRequest } from "next/server";

import {
  registerOAuthClient,
  oauthErrorResponse,
} from "@/lib/mcp/oauth";
import { readJson, json } from "@/lib/mcp/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: NextRequest) {
  try {
    return json(
      await registerOAuthClient(
        await readJson(request, 8192),
      ),
      201,
    );
  } catch (error) {
    return oauthErrorResponse(error);
  }
}
