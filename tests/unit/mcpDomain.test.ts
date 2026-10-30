import { beforeEach, describe, expect, it, vi } from "vitest";
import { MfmfMcpAdapter, type McpReadRepository } from "@/lib/mcp/domain";
const id = "93000000-0000-4000-8000-000000000001";
const petId = "94000000-0000-4000-8000-000000000001";
const row = { id, pet_id: petId, source: "home", record_date: "2026-10-29", body: "架空の記録", weight_kg: 4.2 };
let repository: McpReadRepository;
beforeEach(() => { repository = { pets: vi.fn().mockResolvedValue([{ id: petId, name: "架空ペット", species: "犬" }]), search: vi.fn().mockResolvedValue([row]), record: vi.fn().mockResolvedValue(row) }; });
describe("MCP explicit read-only DTOs and bounded arguments", () => {
  it("returns only allowed pet and record fields", async () => {
    const adapter = new MfmfMcpAdapter(repository);
    expect(await adapter.call("list_pets", {})).toEqual({ pets: [{ id: petId, name: "架空ペット", species: "犬" }], nextOffset: null });
    expect(await adapter.call("get_record", { id })).toEqual({ record: { id, petId, date: "2026-10-29", source: "home", weightKg: 4.2, body: "架空の記録", bodyTruncated: false } });
  });
  it.each([
    ["delete_record", {}], ["list_pets", { userId: id }], ["get_record", { id: "invalid" }], ["get_record", { id, householdId: id }],
    ["search_records", { query: "a".repeat(101) }], ["search_records", { limit: 21 }], ["search_records", { offset: 501 }],
    ["search_records", { from: "2027-02-30", to: "2027-03-01" }], ["search_records", { from: "2026-10-01" }],
    ["search_records", { from: "2026-01-01", to: "2026-04-01" }], ["search_records", { from: "2026-10-02", to: "2026-10-01" }],
  ])("rejects invalid tool/arguments before any database call: %s %j", async (tool, args) => {
    await expect(new MfmfMcpAdapter(repository).call(tool as string, args)).rejects.toMatchObject({ kind: "invalid" });
    expect(repository.pets).not.toHaveBeenCalled(); expect(repository.search).not.toHaveBeenCalled(); expect(repository.record).not.toHaveBeenCalled();
  });
  it("bounds body output and hides emails, URLs and embedded identity UUIDs", async () => {
    vi.mocked(repository.record).mockResolvedValue({ ...row, body: `日本語@例え.テスト https://example.test/?token=secret ${id} ` + "猫".repeat(2100) });
    const result = await new MfmfMcpAdapter(repository).call("get_record", { id });
    const record = result.record as { body: string; bodyTruncated: boolean };
    expect(record.body.length).toBe(2000); expect(record.bodyTruncated).toBe(true);
    for (const privateValue of ["日本語@例え.テスト", "token=secret", id]) expect(record.body).not.toContain(privateValue);
  });
  it("does not serialize extra fields supplied by a repository", async () => {
    vi.mocked(repository.record).mockResolvedValue({ ...row, owner_id: id, household_id: id, author: "private-author", record_photos: [{ url: "signed-secret" }] } as typeof row);
    const result = JSON.stringify(await new MfmfMcpAdapter(repository).call("get_record", { id }));
    for (const key of ["owner_id", "household_id", "private-author", "signed-secret"]) expect(result).not.toContain(key);
  });
  it("uses a bounded default period and one extra row only to detect paging", async () => {
    await new MfmfMcpAdapter(repository).call("search_records", {});
    const input = vi.mocked(repository.search).mock.calls[0][0];
    expect(Date.parse(input.to) - Date.parse(input.from)).toBe(30 * 86400_000); expect(input.limit).toBe(21);
  });
  it("fails closed for inaccessible or corrupt rows and hides raw failures", async () => {
    vi.mocked(repository.record).mockResolvedValue(null);
    await expect(new MfmfMcpAdapter(repository).call("get_record", { id })).rejects.toMatchObject({ kind: "not_found" });
    vi.mocked(repository.record).mockResolvedValue({ ...row, source: "corrupt" });
    await expect(new MfmfMcpAdapter(repository).call("get_record", { id })).rejects.toMatchObject({ kind: "unavailable" });
    vi.mocked(repository.record).mockRejectedValue(new Error("private-database-details"));
    await expect(new MfmfMcpAdapter(repository).call("get_record", { id })).rejects.not.toThrow("private-database-details");
  });
});
