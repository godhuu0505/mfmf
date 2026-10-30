import McpConsentPanel from "@/components/mcp/McpConsentPanel";
import { McpFrame } from "@/components/mcp/McpFrame";

export const dynamic = "force-dynamic";
export const metadata = { title: "AIとの接続の確認", robots: { index: false, follow: false } };

/** Middleware protects the page; the existing API independently verifies every read/mutation. */
export default async function ConsentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[A-Za-z0-9_-]{43}$/u.test(id)) return <McpFrame><section className="space-y-4 rounded-2xl bg-surface p-5 shadow-sm ring-1 ring-border"><h1 className="text-xl font-bold">接続の申し込みが見つかりません</h1><p className="text-sm leading-relaxed text-muted-foreground">接続元のサービスから、もう一度お申し込みください。</p><a className="inline-flex min-h-11 items-center text-sm text-primary" href="/connections">現在の接続を確認する</a></section></McpFrame>;
  return <McpConsentPanel transactionId={id} />;
}
