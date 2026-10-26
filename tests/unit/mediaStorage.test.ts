import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ rpc: vi.fn(), stat: vi.fn(), signRead: vi.fn(), publish: vi.fn(), remove: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc: mock.rpc }) }));
vi.mock("@/lib/mediaAuthorization", () => ({ assertAuthorizedMediaDescriptor: () => {} }));
vi.mock("@/lib/gcsStorage", () => ({ createGcsStorage: () => ({ stat: mock.stat, signRead: mock.signRead, publish: mock.publish, deleteGeneration: mock.remove }) }));
import { parseMediaAsset, signedGcsMediaUrl, cleanupDeletedMedia, finalizeMediaUpload, requireMediaWrites } from "@/lib/mediaStorage";
import type { AuthorizedMediaDescriptor } from "@/lib/mediaAuthorization";

const id = "10000000-0000-4000-8000-000000000001";
const owner = "20000000-0000-4000-8000-000000000002";
const household = "30000000-0000-4000-8000-000000000003";
const record = "40000000-0000-4000-8000-000000000004";
const path = `${household}/${record}/${id}`;
function asset(overrides: Record<string, unknown> = {}) {
  return { id, kind: "photo", entity_id: record, household_id: household, owner_id: owner, created_by: owner,
    incoming_key: `_incoming/${id}`, final_key: path, byte_size: 100, content_type: "image/png", state: "ready",
    expires_at: "2999-01-01T00:00:00Z", generation: "200", is_legacy: false, ...overrides };
}
function metadata(overrides: Record<string, unknown> = {}) {
  return { bucket: "photos", name: path, generation: "200", size: 100, contentType: "image/png", crc32c: "AAAAAA==",
    binding: { schema: "1", state: "ready", kind: "record-photo", entityId: record, householdId: household,
      ownerId: owner, reservationId: id, sourceGeneration: "100" }, ...overrides };
}
const descriptor = { kind: "photo", photoId: id, recordId: record, entityId: id, assetId: id,
  householdId: household, ownerId: owner, path, actorId: owner, bucket: "daycare-photos" } as AuthorizedMediaDescriptor;

beforeEach(() => {
  vi.clearAllMocks();
  mock.rpc.mockResolvedValue({ data: asset(), error: null });
  mock.stat.mockResolvedValue(metadata());
  mock.signRead.mockResolvedValue("https://example.invalid/private");
  mock.remove.mockResolvedValue(undefined);
});

describe("GCS media application boundary", () => {
  it("requires the referenced immutable generation and provider binding before signing", async () => {
    expect(await signedGcsMediaUrl(descriptor, 300)).toBe("https://example.invalid/private");
    expect(mock.stat).toHaveBeenCalledWith({ bucket: "photos", name: path, generation: "200" });
    expect(mock.signRead).toHaveBeenCalledWith(expect.objectContaining({ generation: "200" }), 300);
  });
  it.each(["deleted", "reserved"])("never signs an asset in %s state", async (state) => {
    mock.rpc.mockResolvedValue({ data: asset({ state }), error: null });
    expect(await signedGcsMediaUrl(descriptor, 300)).toBeNull();
    expect(mock.stat).not.toHaveBeenCalled();
    expect(mock.signRead).not.toHaveBeenCalled();
  });
  it("does not treat a client-claimed completed RPC as evidence an object exists", async () => {
    mock.stat.mockResolvedValue(null);
    expect(await signedGcsMediaUrl(descriptor, 300)).toBeNull();
    expect(mock.signRead).not.toHaveBeenCalled();
  });
  it("rejects a target mismatch even if a supplied asset ID is otherwise readable", async () => {
    await expect(signedGcsMediaUrl({ ...descriptor, recordId: owner } as AuthorizedMediaDescriptor, 300)).rejects.toThrow();
    expect(mock.stat).not.toHaveBeenCalled();
  });
  it.each(["ownerId", "householdId", "entityId", "reservationId"])("rejects a forged provider %s binding", async (key) => {
    const value = metadata();
    mock.stat.mockResolvedValue({ ...value, binding: { ...value.binding, [key]: "ffffffff-ffff-4fff-8fff-ffffffffffff" } });
    await expect(signedGcsMediaUrl(descriptor, 300)).rejects.toThrow();
    expect(mock.signRead).not.toHaveBeenCalled();
  });
  it("surfaces a provider failure rather than falling back to the source copy", async () => {
    mock.stat.mockRejectedValue(new Error("provider unavailable"));
    await expect(signedGcsMediaUrl(descriptor, 300)).rejects.toThrow("provider unavailable");
    expect(mock.signRead).not.toHaveBeenCalled();
  });
  it("refuses cleanup before a terminal database deletion", async () => {
    await expect(cleanupDeletedMedia(parseMediaAsset(asset()))).rejects.toThrow();
    expect(mock.stat).not.toHaveBeenCalled();
    expect(mock.remove).not.toHaveBeenCalled();
  });
  it("deletes only the ledger generation, preserving a replacement live object", async () => {
    mock.stat.mockResolvedValueOnce(metadata()).mockResolvedValueOnce(null);
    await cleanupDeletedMedia(parseMediaAsset(asset({ state: "deleted" })));
    expect(mock.remove).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ generation: "200", name: path }));
  });
  it("does not publish when cancellation wins after the provider copy", async () => {
    mock.rpc.mockResolvedValueOnce({ data: asset({ state: "reserved", generation: null }), error: null })
      .mockResolvedValueOnce({ data: asset({ state: "deleted", generation: null }), error: null });
    const incoming = { ...metadata(), name: `_incoming/${id}`, generation: "100", binding: null };
    mock.stat.mockResolvedValueOnce(null).mockResolvedValueOnce(incoming).mockResolvedValueOnce(metadata()).mockResolvedValueOnce(incoming);
    mock.publish.mockResolvedValue(metadata());
    await expect(finalizeMediaUpload({ rpc: mock.rpc } as never, owner, id,
      { kind: "photo", entityId: record, householdId: household })).rejects.toThrow("取り消されました");
    expect(mock.rpc.mock.calls.map((call) => call[0])).toEqual(["get_media_upload", "get_media_upload"]);
    expect(mock.remove).toHaveBeenCalledWith(expect.objectContaining({ generation: "200" }));
  });
  it("blocks writes during the source snapshot freeze", async () => {
    mock.rpc.mockResolvedValue({ data: "frozen", error: null });
    await expect(requireMediaWrites()).rejects.toThrow("切り替えています");
  });
  it("cannot substitute an arbitrary final path in a nonlegacy reservation", () => {
    expect(() => parseMediaAsset(asset({ final_key: `${household}/${record}/${owner}` }))).toThrow();
  });
});
