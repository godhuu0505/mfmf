"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { findRelatedRecords, type RelatedRecordResult } from "@/lib/relatedRecords";

export type RelatedRecordDisplay = { id: string; recordDate: string; source: string; body: string };
export type RelatedSearchResponse = {
  status: RelatedRecordResult["status"];
  records: RelatedRecordDisplay[];
  candidateCount: number;
  truncated: boolean;
};

export async function searchRelatedRecords(formData: FormData): Promise<RelatedSearchResponse> {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) redirect("/login");
  const invalid: RelatedSearchResponse = { status: "unavailable", records: [], candidateCount: 0, truncated: false };
  const value = (name: string) => {
    const item = formData.get(name);
    return item === null ? "" : typeof item === "string" ? item : null;
  };
  const query = value("q"); const source = value("source"); const from = value("from"); const to = value("to"); const tagId = value("tag");
  if ([query, source, from, to, tagId].some((item) => item === null)) return invalid;
  try {
    const result = await findRelatedRecords({ query: query!, source: source!, from: from!, to: to!, tagId: tagId! }, { supabase });
    return {
      status: result.status, candidateCount: result.candidateCount, truncated: result.truncated,
      records: result.records.map((row) => ({ id: row.id, recordDate: row.record_date, source: row.source, body: row.body })),
    };
  } catch { return invalid; }
}
