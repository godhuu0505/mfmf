import "server-only";
import { z } from "zod";
import { RECORD_SOURCES } from "@/types/database";
import { jstTodayISO } from "@/lib/dateRange";

const uuid = z.uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
const paging = { offset: z.number().int().min(0).max(500).default(0), limit: z.number().int().min(1).max(20).default(20) };
const search = z.strictObject({ ...paging, query: z.string().trim().max(100).default(""), from: date.optional(), to: date.optional(), petId: uuid.optional(), source: z.enum(RECORD_SOURCES).optional() }).refine(input => {
  if (Boolean(input.from) !== Boolean(input.to)) return false;
  if (!input.from || !input.to) return true;
  const days = (Date.parse(input.to) - Date.parse(input.from)) / 86400_000;
  return days >= 0 && days <= 61;
});
const summary = z.strictObject({ id: uuid, date, source: z.enum(RECORD_SOURCES), petId: uuid.nullable(), excerpt: z.string().max(120), weightKg: z.number().finite().positive().max(500).nullable() });
const detail = summary.omit({ excerpt: true }).extend({ body: z.string().max(2000), bodyTruncated: z.boolean() });
export const MCP_SCOPE = "mfmf.read";
export const MCP_TOOL_DEFINITIONS = [
  { name: "list_pets", title: "家族のペットを一覧する", description: "接続時に選んだ家族のペット名と種類だけを読み取ります。写真・誕生日・メンバー情報は返しません。", input: z.strictObject(paging), output: z.strictObject({ pets: z.array(z.strictObject({ id: uuid, name: z.string().max(80), species: z.string().max(40).nullable() })).max(20), nextOffset: z.number().int().min(0).max(500).nullable() }) },
  { name: "search_records", title: "家族の記録を探す", description: "選択した家族の記録ずみの本文を通常の文字検索で探します。期間は最大62日、未指定は直近31日です。予定・見送り・写真・記入者情報は返しません。Google Rankingや外部検索は行いません。", input: search, output: z.strictObject({ from: date, to: date, records: z.array(summary).max(20), nextOffset: z.number().int().min(0).max(500).nullable() }) },
  { name: "get_record", title: "記録の本文を読む", description: "選択した家族の記録ずみ1件を読み取ります。本文は最大2000文字。写真・写真URL・記入者・メンバー情報は返しません。", input: z.strictObject({ id: uuid }), output: z.strictObject({ record: detail }) },
] as const;
export type McpSearch = z.infer<typeof search> & { from: string; to: string };
export type McpRecordRow = { id: string; record_date: string; source: string; pet_id: string | null; body: string; weight_kg: number | null };
export interface McpReadRepository {
  pets(offset: number, limit: number): Promise<{ id: string; name: string; species: string | null }[]>;
  search(input: McpSearch): Promise<McpRecordRow[]>;
  record(id: string): Promise<McpRecordRow | null>;
}
export class McpDomainError extends Error {
  constructor(public readonly kind: "invalid" | "not_found" | "unavailable") { super(kind === "invalid" ? "入力を確認してください。期間は両端を指定し、62日以内にしてください。" : kind === "not_found" ? "対象が見つからないか、現在のアクセス権がありません。" : "記録を読み込めませんでした。時間をおいてお試しください。"); }
}
const email = /[\p{L}\p{N}.!#$%&'*+/=?^`{|}~-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;
function clean(value: string, maximum: number) {
  return value.normalize("NFC").replace(email, "[メール非表示]").replace(/https?:\/\/[^\s<>]+/giu, "[URL非表示]")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu, "[ID非表示]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ").slice(0, maximum);
}
function base(row: McpRecordRow) { return { id: row.id, date: row.record_date, source: row.source, petId: row.pet_id, weightKg: row.weight_kg }; }
function page<T>(rows: T[], offset: number, limit: number) { return { rows: rows.slice(0, limit), nextOffset: rows.length > limit && offset + limit <= 500 ? offset + limit : null }; }

/** Per-request adapter receives a read-only repository, never a mutation client. */
export class MfmfMcpAdapter {
  constructor(private readonly repository: McpReadRepository) {}
  async call(name: string, arguments_: unknown): Promise<Record<string, unknown>> {
    const tool = MCP_TOOL_DEFINITIONS.find(item => item.name === name);
    if (!tool || !tool.input.safeParse(arguments_ ?? {}).success) throw new McpDomainError("invalid");
    try {
      let data: Record<string, unknown>;
      if (name === "list_pets") {
        const input = MCP_TOOL_DEFINITIONS[0].input.parse(arguments_ ?? {});
        const result = page(await this.repository.pets(input.offset, input.limit + 1), input.offset, input.limit);
        data = { pets: result.rows.map(row => ({ id: row.id, name: clean(row.name, 80), species: row.species === null ? null : clean(row.species, 40) })), nextOffset: result.nextOffset };
      } else if (name === "search_records") {
        const input = search.parse(arguments_ ?? {});
        const to = input.to ?? jstTodayISO();
        const from = input.from ?? new Date(Date.parse(to) - 30 * 86400_000).toISOString().slice(0, 10);
        const result = page(await this.repository.search({ ...input, from, to, limit: input.limit + 1 }), input.offset, input.limit);
        data = { from, to, records: result.rows.map(row => ({ ...base(row), excerpt: clean(row.body, 120) })), nextOffset: result.nextOffset };
      } else {
        const { id } = MCP_TOOL_DEFINITIONS[2].input.parse(arguments_);
        const row = await this.repository.record(id);
        if (!row) throw new McpDomainError("not_found");
        data = { record: { ...base(row), body: clean(row.body, 2000), bodyTruncated: clean(row.body, 2001).length > 2000 } };
      }
      const output = tool.output.safeParse(data);
      if (!output.success || Buffer.byteLength(JSON.stringify(output.data), "utf8") > 65_536) throw new McpDomainError("unavailable");
      return output.data;
    } catch (error) { if (error instanceof McpDomainError) throw error; throw new McpDomainError("unavailable"); }
  }
}
