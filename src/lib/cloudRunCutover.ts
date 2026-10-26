const CLOUD_RUN_ORIGIN = "https://mfmf-candidate-wspqvmhj6q-an.a.run.app";

// Keep already-issued recovery links usable on their original cookie origin.
// Normal app traffic moves to the runtime that has keyless GCS credentials.
export function cloudRunCutoverRoute(input: {
  vercel: boolean; mode: "supabase" | "frozen" | "gcs";
  method: string; pathname: string; search: string;
}): { kind: "continue" } | { kind: "redirect"; location: string } | { kind: "reload" } {
  if (!input.vercel || input.mode !== "gcs") return { kind: "continue" };
  const read = input.method === "GET" || input.method === "HEAD";
  if (read && ["/auth/callback", "/reset-password"].includes(input.pathname)) return { kind: "continue" };
  if (input.method === "POST" && ["/auth/next", "/auth/signout"].includes(input.pathname)) return { kind: "continue" };
  // Never forward an old bound Server Action, body or auth-bearing POST across origins.
  if (!read) return { kind: "reload" };
  const destination = new URL(CLOUD_RUN_ORIGIN);
  destination.pathname = input.pathname;
  destination.search = input.search;
  return { kind: "redirect", location: destination.href };
}
