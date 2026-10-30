"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { connectionsSchema, failureOf, mcpJson, type BrowserFailure, type Connection } from "./browser";
import { McpFailure, McpFrame } from "./McpFrame";

type Connections = z.infer<typeof connectionsSchema>;
const revokeSchema = z.strictObject({ revoked: z.literal(true) });
const dateLabel = (value: string) => new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "medium", timeZone: "Asia/Tokyo" }).format(new Date(value));

export default function McpConnectionsPanel() {
  const [data, setData] = useState<Connections | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<BrowserFailure | null>(null);
  const [message, setMessage] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const pending = useRef(false);
  const revision = useRef(0);

  const load = useCallback(async (signal?: AbortSignal) => {
    const request = ++revision.current;
    setLoading(true); setFailure(null); setMessage("");
    try {
      const result = await mcpJson("/api/oauth/connections", connectionsSchema, { signal });
      if (request === revision.current && !signal?.aborted) setData(result);
    } catch (error) {
      if (request === revision.current && !signal?.aborted) {
        const kind = failureOf(error); setFailure(kind);
        if (kind === "unauthenticated") setData(null);
      }
    } finally {
      if (request === revision.current && !signal?.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController(); void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function revoke(connection: Connection) {
    if (pending.current || failure || !data || loading) return;
    pending.current = true; setBusyId(connection.id); setFailure(null); setMessage("");
    try {
      await mcpJson("/api/oauth/connections", revokeSchema, { method: "DELETE", csrf: data.csrfToken, body: { id: connection.id } });
      setData(current => current ? { ...current, connections: current.connections.filter(item => item.id !== connection.id) } : current);
      setMessage(`${connection.clientName}・${connection.householdName}との接続を解除しました。`);
    } catch (error) {
      const kind = failureOf(error); setFailure(kind);
      if (kind === "unauthenticated") setData(null);
    } finally { pending.current = false; setBusyId(null); }
  }

  return <McpFrame><div className="space-y-5">
    <a href="/settings/account" className="inline-flex min-h-11 items-center text-sm text-muted-foreground hover:text-foreground">← アカウント設定へ戻る</a>
    <div className="space-y-2"><h1 className="text-xl font-bold">AIとの接続</h1><p className="text-sm leading-relaxed text-muted-foreground">あなたが許可した接続です。接続先の家族と有効期限を確認できます。</p></div>
    <div className="rounded-xl border border-border bg-surface p-4 text-sm leading-relaxed text-muted-foreground">解除すると、新たな閲覧を停止します。AIサービスがすでに受け取った内容は削除されません。接続先のサービスでも確認してください。</div>
    {message && <p role="status" className="text-sm font-medium text-primary">{message}</p>}
    {failure && <McpFailure kind={failure} returnTo="/connections" retry={() => void load()} />}
    {loading && <p role="status" className="text-sm text-muted-foreground">接続を確認しています…</p>}
    {!loading && !failure && data?.connections.length === 0 && <section className="space-y-3 rounded-2xl border border-dashed border-border bg-surface p-6 text-center"><h2 className="text-base font-semibold">接続中のAIサービスはありません</h2><p className="text-sm leading-relaxed text-muted-foreground">使いたいサービスから接続を申し込むと、ここで確認できます。</p></section>}
    {data && <div className="space-y-4" aria-label="接続中のAIサービス" aria-busy={loading || busyId !== null}>
      {data.connections.map(connection => <article key={connection.id} data-connection-id={connection.id} className="space-y-4 rounded-2xl bg-surface p-5 shadow-sm ring-1 ring-border">
        <div className="flex items-start justify-between gap-3"><h2 className="min-w-0 break-words text-lg font-bold">{connection.clientName}</h2><span className="shrink-0 rounded-full bg-surface-muted px-2 py-1 text-xs font-medium text-primary">閲覧のみ</span></div>
        <div><p className="text-xs text-muted-foreground">接続先の家族</p><p className="mt-1 break-words text-sm font-semibold">{connection.householdName}</p></div>
        <dl className="space-y-2 text-xs text-muted-foreground"><div className="flex flex-wrap justify-between gap-x-3 gap-y-1"><dt>接続した日時</dt><dd className="text-foreground">{dateLabel(connection.createdAt)}</dd></div><div className="flex flex-wrap justify-between gap-x-3 gap-y-1"><dt>有効期限</dt><dd className="text-foreground">{dateLabel(connection.expiresAt)}</dd></div><div className="flex flex-wrap justify-between gap-x-3 gap-y-1"><dt>接続番号の末尾</dt><dd className="font-mono text-foreground">{connection.id.slice(-6)}</dd></div></dl>
        <button type="button" onClick={() => void revoke(connection)} disabled={busyId !== null || loading || failure !== null} aria-label={`${connection.clientName}・${connection.householdName}・${dateLabel(connection.createdAt)}・末尾${connection.id.slice(-6)}の接続を解除`} className="min-h-11 w-full rounded-xl border border-border px-4 py-2 text-sm font-medium text-red-700 hover:bg-surface-muted disabled:opacity-40 dark:text-red-300">{busyId === connection.id ? "解除しています…" : "接続を解除"}</button>
      </article>)}
    </div>}
  </div></McpFrame>;
}
