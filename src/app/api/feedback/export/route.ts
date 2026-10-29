import { createClient } from "@/lib/supabase/server";
import { isGcpAuthEnabled } from "@/lib/identity/config";
import { feedbackExportId, feedbackExportRecord } from "@/lib/feedbackExport";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const headers = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};
const error = (status: number) => Response.json({ error: "フィードバックを出力できません。" }, { status, headers });

/** A manual, authenticated download. This route has no GitHub credentials or write path. */
export async function GET(request: Request) {
  try {
    // The old Supabase production source is frozen. Never fall back to it.
    if (!isGcpAuthEnabled()) return error(404);
    const site = request.headers.get("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none") return error(403);
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some((key) => key !== "id") || params.getAll("id").length > 1) return error(400);
    let id: string | null;
    try { id = feedbackExportId(params.get("id")); } catch { return error(400); }
    const client = await createClient();
    const { data: { user }, error: authError } = await client.auth.getUser();
    if (authError || !user) return error(401);
    // RLS remains the primary boundary; own-only is deliberately narrower than
    // feedback_select_member. Viewer/guest membership cannot export others' reports.
    let query = client.from("feedback")
      .select("id,kind,severity,frequency,context,created_at")
      .eq("owner_id", user.id)
      .is("github_issue_number", null)
      .order("created_at", { ascending: true })
      .limit(101);
    if (id) query = query.eq("id", id);
    const { data, error: queryError } = await query;
    if (queryError || !Array.isArray(data)) return error(503);
    const records = data.slice(0, 100).map(feedbackExportRecord);
    return Response.json({ schema: 1, source: "mfmf-gcp-feedback", hasMore: data.length > 100, records }, {
      headers: { ...headers, "Content-Disposition": 'attachment; filename="mfmf-feedback.json"' },
    });
  } catch {
    // Do not let database/provider errors reach telemetry with report contents.
    return error(503);
  }
}
