import { createRoot } from "react-dom/client";
import McpConsentPanel from "@/components/mcp/McpConsentPanel";
import McpConnectionsPanel from "@/components/mcp/McpConnectionsPanel";
import "./styles.css";

const view = new URLSearchParams(location.search).get("view");
createRoot(document.getElementById("root")!).render(
  view === "connections" ? <McpConnectionsPanel /> : <McpConsentPanel transactionId={"t".repeat(43)} />,
);
