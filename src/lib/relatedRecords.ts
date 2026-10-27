import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createRanking, rankingEnabled } from "@/lib/ranking";
import { prepareRanking, RANKING_MAX_CANDIDATES } from "@/lib/rankingPrivacy";
import { householdScopeFilter, type Membership } from "@/lib/household";
import { RECORD_SOURCES, type RecordWithPhotos } from "@/types/database";

type ServerClient = Awaited<ReturnType<typeof createClient>>;
type RelatedRecord = Pick<RecordWithPhotos, "id" | "record_date" | "source" | "body" | "author">;
export type RelatedRecordInput = {
  query: string;
  source?: string;
  from?: string;
  to?: string;
  tagId?: string;
};
export type RelatedRecordResult =
  | { status: "ranked"; records: RelatedRecord[]; candidateCount: number; truncated: boolean }
  | { status: "disabled" | "empty" | "limited" | "unavailable"; records: []; candidateCount: 0; truncated: false };

const empty = (status: "disabled" | "empty" | "limited" | "unavailable"): RelatedRecordResult =>
  ({ status, records: [], candidateCount: 0, truncated: false });

/** Called only by an explicit opt-in action, never by a normal keyword search or prefetch. */
export async function findRelatedRecords(input: RelatedRecordInput, dependencies: {
  supabase?: ServerClient;
  membership?: Membership | null;
  rank?: ReturnType<typeof createRanking>;
  enabled?: boolean;
} = {}): Promise<RelatedRecordResult> {
  if (!(dependencies.enabled ?? rankingEnabled())) return empty("disabled");
  if (typeof input.query !== "string" || !input.query.trim() || input.query.length > 200 ||
      [input.from, input.to].some((value) => value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) ||
      (input.from && input.to && input.from > input.to) ||
      (input.source && input.source !== "all" && !RECORD_SOURCES.includes(input.source as typeof RECORD_SOURCES[number])) ||
      (input.tagId && !/^[0-9a-f-]{36}$/i.test(input.tagId))) return empty("unavailable");
  const supabase = dependencies.supabase ?? await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return empty("unavailable");

  // Membership is resolved again from the authenticated caller, never from request data.
  const { getCurrentMembership } = await import("@/lib/household");
  const membership = dependencies.membership === undefined ? await getCurrentMembership(supabase) : dependencies.membership;
  if (!membership) return empty("unavailable");
  let taggedIds: string[] | null = null;
  if (input.tagId) {
    const { data, error } = await supabase.from("record_tags").select("record_id").eq("tag_id", input.tagId).limit(1001);
    if (error || !data || data.length > 1000) return empty("unavailable");
    taggedIds = data.map((row) => row.record_id);
    if (!taggedIds.length) return empty("empty");
  }
  // Supabase RLS is the security boundary. There is no privileged/service-role client.
  let query = supabase.from("daycare_records")
    .select("id, record_date, source, body, author, pets(name)")
    .eq("status", "done").or(householdScopeFilter(membership.householdId))
    .order("record_date", { ascending: false }).order("created_at", { ascending: false }).order("id", { ascending: false });
  if (input.source && input.source !== "all") query = query.eq("source", input.source);
  if (input.from) query = query.gte("record_date", input.from);
  if (input.to) query = query.lte("record_date", input.to);
  if (taggedIds) query = query.in("id", taggedIds);
  const { data, error } = await query.limit(RANKING_MAX_CANDIDATES + 1);
  if (error || !data) return empty("unavailable");
  const candidates = data.slice(0, RANKING_MAX_CANDIDATES) as unknown as (RelatedRecord & { pets?: { name: string } | null })[];
  if (!candidates.length) return empty("empty");
  const names = [...new Set(candidates.flatMap((row) => [row.author, row.pets?.name])
    .concat([user.user_metadata?.display_name as string, user.user_metadata?.full_name as string, user.email])
    .filter((name): name is string => typeof name === "string" && name.trim().length > 0))];
  const preparedCandidates = candidates.map((row) => ({ id: row.id, title: `記録元：${row.source}`, content: row.body }));
  try { prepareRanking(input.query, preparedCandidates, names); } catch { return empty("unavailable"); }
  // Atomic, project-wide reservation precedes both metadata authentication and the paid API.
  const reservation = await supabase.rpc("reserve_record_ranking", { p_household: membership.householdId });
  if (reservation.error || !reservation.data || typeof reservation.data !== "object" || reservation.data.allowed !== true) return empty("limited");
  try {
    const ids = await (dependencies.rank ?? createRanking())(input.query, preparedCandidates, names);
    const byId = new Map(candidates.map((row) => [row.id, row]));
    if (ids.length !== candidates.length || new Set(ids).size !== ids.length || ids.some((id) => !byId.has(id))) return empty("unavailable");
    return { status: "ranked", records: ids.map((id) => byId.get(id)!), candidateCount: candidates.length,
      truncated: data.length > RANKING_MAX_CANDIDATES };
  } catch { return empty("unavailable"); }
}
