import "server-only";
import { createHash } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGES: Record<string, string> = {
  "/": "home", "/records/new": "record-new", "/calendar": "calendar",
  "/gallery": "gallery", "/pets": "pets", "/weight": "weight",
  "/settings": "settings", "/settings/account": "account", "/feedback": "feedback",
  "/onboarding": "onboarding", "/guest": "guest", "/guest/records/new": "guest-record-new",
  "/records/[id]": "record-detail", "/share/[token]": "share", "/invite/[token]": "invite",
  "/pets/[id]": "pets", "/auth/*": "authentication", "/api/*": "api",
};

/** Never export free text, a source URL, device details or an account/household ID. */
export function feedbackExportRecord(row: Record<string, unknown>) {
  if (typeof row.id !== "string" || !UUID.test(row.id)) throw new Error("Invalid feedback export.");
  const context = row.context && typeof row.context === "object" && !Array.isArray(row.context)
    ? row.context as Record<string, unknown> : {};
  const path = typeof context.page_path === "string" ? context.page_path.split(/[?#]/, 1)[0] : "";
  const page = Object.hasOwn(PAGES, path) ? PAGES[path] : (/^\/records\/[0-9a-f-]{36}$/i.test(path) ? "record-detail" : "other");
  const kind = typeof row.kind === "string" && ["bug", "request", "question"].includes(row.kind) ? row.kind : "question";
  const severity = typeof row.severity === "string" && ["blocker", "annoying", "minor", "idea"].includes(row.severity) ? row.severity : null;
  const frequency = typeof row.frequency === "string" && ["always", "sometimes", "once", "unknown"].includes(row.frequency) ? row.frequency : null;
  if (typeof row.created_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(row.created_at) || !Number.isFinite(Date.parse(row.created_at))) {
    throw new Error("Invalid feedback date.");
  }
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(row.created_at));
  return {
    reference: createHash("sha256").update(`mfmf-gcp-feedback:v1:${row.id.toLowerCase()}`).digest("hex"),
    kind, severity, frequency, page, date,
  };
}

export function feedbackExportId(value: string | null): string | null {
  if (value === null) return null;
  if (!UUID.test(value)) throw new Error("Invalid feedback selection.");
  return value.toLowerCase();
}
