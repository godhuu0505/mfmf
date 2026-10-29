import McpConnectionsPanel from "@/components/mcp/McpConnectionsPanel";

export const dynamic = "force-dynamic";
export const metadata = { title: "AIとの接続", robots: { index: false, follow: false } };

export default function ConnectionsPage() { return <McpConnectionsPanel />; }
