import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  photos: vi.fn(), avatars: vi.fn(), sign: vi.fn(), from: vi.fn(),
}));
vi.mock("@/lib/mediaStorage", () => ({ getMediaStorageMode: async () => "supabase" }));
vi.mock("@/lib/mediaAuthorization", () => ({
  authorizePhotoReads: mocks.photos,
  authorizeAvatarReads: mocks.avatars,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ storage: { from: mocks.from } }),
}));
import { createPhotoSignedUrls, withSignedUrls } from "@/lib/photos";
import { createAvatarSignedUrls } from "@/lib/avatars";
import type { RecordPhoto } from "@/types/database";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.from.mockReturnValue({ createSignedUrls: mocks.sign });
  mocks.sign.mockResolvedValue({ data: [], error: null });
});

describe("media signing after authorization", () => {
  it("signs only paths returned by authorization and maps URLs to photo IDs", async () => {
    mocks.photos.mockResolvedValue([{ photoId: "allowed", path: "verified/path" }]);
    mocks.sign.mockResolvedValue({ data: [
      { path: "verified/path", signedUrl: "https://example.com/allowed" },
      { path: "unrequested/path", signedUrl: "https://example.com/unrequested" },
    ], error: null });
    const urls = await createPhotoSignedUrls(["allowed", "invisible"]);
    expect(mocks.photos).toHaveBeenCalledWith(["allowed", "invisible"]);
    expect(mocks.sign).toHaveBeenCalledWith(["verified/path"], 3600);
    expect([...urls]).toEqual([["allowed", "https://example.com/allowed"]]);
  });

  it("does not sign a row supplied by a caller when its ID is not authorized", async () => {
    mocks.photos.mockResolvedValue([]);
    const input = [{ id: "invisible", storage_path: "other-household/private.jpg" }] as RecordPhoto[];
    expect(await withSignedUrls(input)).toEqual([{ ...input[0], url: null }]);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("keeps avatar reference kinds separate even when entity IDs coincide", async () => {
    mocks.avatars.mockResolvedValue([{ kind: "profile", entityId: "same", path: "verified/avatar" }]);
    mocks.sign.mockResolvedValue({ data: [{ path: "verified/avatar", signedUrl: "https://example.com/avatar" }], error: null });
    const urls = await createAvatarSignedUrls([
      { kind: "profile", entityId: "same" }, { kind: "household", entityId: "same" },
    ]);
    expect([...urls]).toEqual([["profile:same", "https://example.com/avatar"]]);
  });

  it("does not disguise storage service failures as missing images", async () => {
    mocks.photos.mockResolvedValue([{ photoId: "allowed", path: "verified/path" }]);
    mocks.sign.mockResolvedValue({ data: null, error: { message: "private diagnostic" } });
    await expect(createPhotoSignedUrls(["allowed"])).rejects.toThrow("写真の表示を準備できませんでした");
  });
});
