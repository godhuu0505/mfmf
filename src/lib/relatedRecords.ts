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
  getMembership?: (client: ServerClient) => Promise<Membership | null>;
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
  const getMembership = dependencies.getMembership ?? getCurrentMembership;
  const membership = await getMembership(supabase);
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
    const candidateIds = new Set(candidates.map((row) => row.id));
    if (ids.length !== candidates.length || new Set(ids).size !== ids.length || ids.some((id) => !candidateIds.has(id))) return empty("unavailable");
    // Google can take several seconds. Revalidate the same identity and current
    // membership, then let RLS read the current rows. Never return a stale body
    // from before a deletion, edit, membership revocation or session change.
    const freshAuth = await supabase.auth.getUser();
    if (freshAuth.error || freshAuth.data.user?.id !== user.id) return empty("unavailable");
    const freshMembership = await getMembership(supabase);
    if (!freshMembership || freshMembership.householdId !== membership.householdId) return empty("unavailable");
    let currentIds = ids;
    if (input.tagId) {
      const currentTags = await supabase.from("record_tags").select("record_id")
        .eq("tag_id", input.tagId).in("record_id", ids).limit(RANKING_MAX_CANDIDATES + 1);
      if (currentTags.error || !currentTags.data || currentTags.data.length > RANKING_MAX_CANDIDATES) return empty("unavailable");
      const tagged = new Set(currentTags.data.map((row) => row.record_id));
      currentIds = ids.filter((id) => tagged.has(id));
      if (!currentIds.length) return empty("empty");
    }
    let freshQuery = supabase.from("daycare_records").select("id, record_date, source, body, author")
      .in("id", currentIds).eq("status", "done").or(householdScopeFilter(freshMembership.householdId));
    if (input.source && input.source !== "all") freshQuery = freshQuery.eq("source", input.source);
    if (input.from) freshQuery = freshQuery.gte("record_date", input.from);
    if (input.to) freshQuery = freshQuery.lte("record_date", input.to);
    const fresh = await freshQuery.limit(RANKING_MAX_CANDIDATES);
    if (fresh.error || !fresh.data) return empty("unavailable");
    const currentRows = fresh.data as unknown as RelatedRecord[];
    const allowedIds = new Set(currentIds);
    const byId = new Map(currentRows.filter((row) => candidateIds.has(row.id) && allowedIds.has(row.id)).map((row) => [row.id, {
      id: row.id, record_date: row.record_date, source: row.source, body: row.body, author: row.author,
    }]));
    const records = ids.filter((id) => byId.has(id)).map((id) => byId.get(id)!);
    if (!records.length) return empty("empty");
    return { status: "ranked", records, candidateCount: records.length,
      truncated: data.length > RANKING_MAX_CANDIDATES };
  } catch { return empty("unavailable"); }
}
