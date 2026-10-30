import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { McpDomainError, type McpReadRepository, type McpRecordRow } from "./domain";

/** Every SQL read is both user-RLS protected and explicitly grant-household scoped. */
export function createMcpReadRepository(client: SupabaseClient, userId: string, householdId: string): McpReadRepository {
  async function member() {
    const { data, error } = await client.from("household_members").select("role").eq("user_id", userId).eq("household_id", householdId).maybeSingle();
    if (error || !data || !["owner", "editor", "viewer"].includes(data.role)) throw new McpDomainError("not_found");
  }
  const columns = "id, record_date, source, pet_id, body, weight_kg";
  return {
    async pets(offset, limit) {
      await member();
      const { data, error } = await client.from("pets").select("id, name, species").eq("household_id", householdId).order("created_at").order("id").range(offset, offset + limit - 1);
      if (error || !data) throw new McpDomainError("unavailable");
      await member();
      return data;
    },
    async search(input) {
      await member();
      let query = client.from("daycare_records").select(columns).eq("household_id", householdId).eq("status", "done").gte("record_date", input.from).lte("record_date", input.to);
      if (input.petId) query = query.eq("pet_id", input.petId);
      if (input.source) query = query.eq("source", input.source);
      if (input.query) query = query.ilike("body", `%${input.query.replace(/([\\%_])/gu, "\\$1")}%`);
      const { data, error } = await query.order("record_date", { ascending: false }).order("id").range(input.offset, input.offset + input.limit - 1);
      if (error || !data) throw new McpDomainError("unavailable");
      await member();
      return data as McpRecordRow[];
    },
    async record(id) {
      await member();
      const { data, error } = await client.from("daycare_records").select(columns).eq("household_id", householdId).eq("status", "done").eq("id", id).maybeSingle();
      if (error) throw new McpDomainError("unavailable");
      await member();
      return data as McpRecordRow | null;
    },
  };
}
