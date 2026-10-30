import type { FeedbackContext } from "@/types/database";

// Feedback is user-authored, but its automatically collected context must not
// contain record IDs, invitation tokens, query strings, or arbitrary fields.
const STATIC_PAGES = new Set([
  "/", "/login", "/records/new", "/calendar", "/gallery", "/pets",
  "/weight", "/settings", "/shares", "/feedback", "/offline", "/help",
  "/guest", "/guest/records/new", "/onboarding",
]);

export function feedbackPage(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 2048 || !raw.startsWith("/") || raw.startsWith("//")) return "other";
  const path = raw.split(/[?#]/, 1)[0];
  if (STATIC_PAGES.has(path)) return path;
  if (/^\/records\/[^/]+$/.test(path)) return "/records/[id]";
  if (/^\/share\/[^/]+$/.test(path)) return "/share/[token]";
  if (/^\/invite\/[^/]+$/.test(path)) return "/invite/[token]";
  return "other";
}

export function parseFeedbackContext(raw: FormDataEntryValue | null): FeedbackContext | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 4096) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const result: FeedbackContext = { page_path: feedbackPage(source.page_path) };
  if (typeof source.online === "boolean") result.online = source.online;
  if (typeof source.standalone === "boolean") result.standalone = source.standalone;
  return result;
}
