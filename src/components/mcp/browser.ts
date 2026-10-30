"use client";

import { z } from "zod";

const controlFree = (maximum: number) => z.string().min(1).max(maximum).refine(value => !/[\u0000-\u001f\u007f]/u.test(value));
const opaqueId = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const csrfToken = opaqueId;
export const consentSchema = z.strictObject({
  transactionId: opaqueId,
  clientName: controlFree(200),
  clientId: controlFree(200),
  accountLabel: controlFree(320).optional(),
  eligibleHouseholds: z.array(z.strictObject({ householdId: z.uuid(), householdName: controlFree(120), role: z.enum(["owner", "editor", "viewer"]) })).max(100),
  csrfToken,
});
export const connectionsSchema = z.strictObject({
  connections: z.array(z.strictObject({ id: opaqueId, clientName: controlFree(200), householdName: controlFree(120), createdAt: z.iso.datetime(), expiresAt: z.iso.datetime() })).max(100),
  csrfToken,
});
export type Consent = z.infer<typeof consentSchema>;
export type Connection = z.infer<typeof connectionsSchema>["connections"][number];
export type BrowserFailure = "unauthenticated" | "expired" | "forbidden" | "unavailable" | "busy" | "network";
export class McpBrowserError extends Error {
  constructor(readonly kind: BrowserFailure) { super(kind); }
}

/** Keep credentials in this page's memory only; never follow a login redirect as JSON. */
export async function mcpJson<T>(path: string, schema: z.ZodType<T>, options: { method?: "GET" | "POST" | "DELETE"; csrf?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timer = setTimeout(abort, 10_000);
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (options.body !== undefined) {
      if (!csrfToken.safeParse(options.csrf).success) throw new McpBrowserError("forbidden");
      headers["Content-Type"] = "application/json";
      headers["x-mfmf-csrf"] = options.csrf!;
    }
    const response = await fetch(path, { method: options.method ?? "GET", headers, credentials: "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal: controller.signal, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new McpBrowserError(response.status === 401 ? "unauthenticated" : response.status === 404 || response.status === 410 ? "expired" : response.status === 403 ? "forbidden" : response.status === 429 ? "busy" : "unavailable");
    }
    if (response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") throw new McpBrowserError("network");
    const reader = response.body?.getReader();
    if (!reader) throw new McpBrowserError("unavailable");
    let text = "";
    let size = 0;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 65_536) { await reader.cancel(); throw new McpBrowserError("unavailable"); }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally { reader.releaseLock(); }
    const result = schema.safeParse(JSON.parse(text));
    if (!result.success) throw new McpBrowserError("unavailable");
    return result.data;
  } catch (error) {
    if (error instanceof McpBrowserError) throw error;
    throw new McpBrowserError("network");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

export function loginHref(path: string) {
  const safe = path === "/connections" || /^\/oauth\/consent\/[A-Za-z0-9_-]{43}$/u.test(path) ? path : "/connections";
  return `/login?next=${encodeURIComponent(safe)}`;
}

/** Defense in depth: only the same callbacks supported by the OAuth server. */
export function consentRedirect(value: string): string | null {
  if (/[\u0000-\u0020\u007f\\]/u.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return null;
    const allowed = url.origin === "https://claude.ai" && url.pathname === "/api/mcp/auth_callback" ||
      url.origin === "https://chatgpt.com" && (url.pathname === "/connector_platform_oauth_redirect" || /^\/connector\/oauth\/[A-Za-z0-9_-]{1,160}$/u.test(url.pathname));
    return allowed ? url.href : null;
  } catch { return null; }
}

export const failureOf = (error: unknown): BrowserFailure => error instanceof McpBrowserError ? error.kind : "network";
export const failureText: Record<BrowserFailure, string> = {
  unauthenticated: "ログインの有効期限が切れました。ログインし直してから確認してください。",
  expired: "申し込みが見つかりません。有効期限が切れたか、すでに手続きが完了しています。接続元からもう一度お申し込みください。",
  forbidden: "アクセス権かログイン状態が変わりました。もう一度確認してください。操作は自動で再送しません。",
  unavailable: "AIとの接続を確認できません。準備中か、一時的に利用できない状態です。時間をおいて再度お試しください。",
  busy: "操作が続いています。時間をおいてからもう一度確認してください。",
  network: "通信またはログイン状態を確認できませんでした。接続を確認するか、ログインし直してください。",
};
