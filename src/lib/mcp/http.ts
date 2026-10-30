import "server-only";
export class McpHttpError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string) { super(message); }
}
export function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store, max-age=0", "Pragma": "no-cache", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" } });
}
export async function readJson(request: Request, maximum = 1024): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") throw new McpHttpError("INVALID_INPUT", 415, "入力を確認してください。");
  const reader = request.body?.getReader();
  if (!reader) throw new McpHttpError("INVALID_INPUT", 400, "入力を確認してください。");
  const chunks: Uint8Array[] = []; let size = 0; let expired = false;
  const timer = setTimeout(() => { expired = true; void reader.cancel().catch(() => undefined); }, 5000);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (expired) throw new McpHttpError("INVALID_INPUT", 408, "入力を確認してください。");
      if (done) break;
      size += value.byteLength;
      if (size > maximum) { void reader.cancel().catch(() => undefined); throw new McpHttpError("INVALID_INPUT", 413, "入力を確認してください。"); }
      chunks.push(value);
    }
    const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid");
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof McpHttpError) throw error;
    throw new McpHttpError("INVALID_INPUT", 400, "入力を確認してください。");
  } finally { clearTimeout(timer); reader.releaseLock(); }
}
