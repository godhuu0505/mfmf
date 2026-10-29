import { NextResponse, type NextRequest } from "next/server";
import { getIdentityProtocol } from "@/lib/identity/server";
import { isGcpAuthEnabled } from "@/lib/identity/config";
import { IdentityError } from "@/lib/identity/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
const failure = (status = 400, error = "invalid") => NextResponse.json({ error }, { status, headers });

export async function GET() {
  if (!isGcpAuthEnabled()) return failure(404);
  try { return NextResponse.json({ csrfToken: (await getIdentityProtocol()).csrfToken() }, { headers }); }
  catch { return failure(503, "unavailable"); }
}

export async function POST(request: NextRequest) {
  if (!isGcpAuthEnabled()) return failure(404);
  try {
    const protocol = await getIdentityProtocol();
    if (!protocol.allowsMutation(request)) return failure(403);
    if (request.headers.get("content-type")?.split(";")[0] !== "application/json") return failure(415);
    if (Number(request.headers.get("content-length")) > 8192) return failure(413);
    const reader = request.body?.getReader(); if (!reader) return failure();
    const chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > 8192) { await reader.cancel(); return failure(413); } chunks.push(value); } }
    finally { reader.releaseLock(); }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) return failure();
    switch (body.operation) {
      case "password": await protocol.passwordLogin(body.email, body.password); return NextResponse.json({ signedIn: true }, { headers });
      case "signup":
        try { await protocol.signup(body.email, body.password, body.acceptedTerms); }
        catch (error) {
          // Existing email and invalid credentials cannot be distinguished by the public form.
          if (!(error instanceof IdentityError) || error.code !== "invalid") throw error;
        }
        return NextResponse.json({ sent: true }, { headers });
      case "forgot": await protocol.forgotPassword(body.email); return NextResponse.json({ sent: true }, { headers });
      case "google": return NextResponse.json({ url: await protocol.beginGoogle() }, { headers });
      case "update-password": await protocol.updatePassword(body.password); return NextResponse.json({ signedIn: true }, { headers });
      default: return failure();
    }
  } catch (error) {
    const code = error instanceof IdentityError ? error.code : "unavailable";
    return failure(code === "unavailable" ? 503 : code === "disabled" ? 403 : 400, code);
  }
}
