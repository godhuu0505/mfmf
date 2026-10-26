// Real Supabase Auth/RLS/RPC and application orchestration; only the provider
// transport is fake. No image bytes, IAM credentials or GCS network are used.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GcsBinding, GcsMetadata } from "@/lib/gcsStorage";
import { assertLocalSupabase } from "../localGuard";
import { DB_URL, SUPABASE_URL, PERSONAS } from "./env";
import { loadSeed, loginAs, newDb, todayISO, isRedirectTo } from "./testKit";

const provider = vi.hoisted(() => ({
  objects: new Map<string, GcsMetadata>(), signUpload: vi.fn(), stat: vi.fn(),
  signRead: vi.fn(), publish: vi.fn(), remove: vi.fn(), generation: 1000,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", async () => {
  const { RedirectSentinel } = await import("./mockState");
  return { redirect: (url: string) => { throw new RedirectSentinel(url); } };
});
vi.mock("next/headers", async () => {
  const { fakeCookies } = await import("./mockState");
  return { cookies: async () => fakeCookies };
});
vi.mock("@/lib/supabase/server", async () => {
  const { getServerClient } = await import("./mockState");
  return { createClient: async () => getServerClient() };
});
vi.mock("@/lib/gcsStorage", () => ({ createGcsStorage: () => ({
  signUpload: provider.signUpload, stat: provider.stat, signRead: provider.signRead,
  publish: provider.publish, deleteGeneration: provider.remove,
}) }));
import { beginMediaUpload } from "@/app/(app)/media/actions";
import { createRecord, deletePhoto, updateRecord } from "@/app/(app)/records/actions";
import { createPhotoSignedUrls } from "@/lib/photos";
import { getMediaReadBackend, requireMediaWrites } from "@/lib/mediaStorage";
import { revalidatePath } from "next/cache";

const seed = loadSeed();
const db = newDb();
const recordIds: string[] = [];
let initialized = false;
function form(id: string, assetId?: string) {
  const fd = new FormData();
  fd.set("record_id", id); fd.set("household_id", seed.householdA);
  fd.set("record_date", todayISO()); fd.set("body", "Synthetic GCS integration record");
  fd.set("source", "home"); fd.set("pet_id", seed.petA);
  if (assetId) fd.append("photo_upload_ids", assetId);
  return fd;
}
async function prepare() {
  const id = randomUUID(); recordIds.push(id);
  await loginAs(PERSONAS.aEditor);
  const upload = await beginMediaUpload({ kind: "photo", entityId: id, householdId: seed.householdA }, 100, "image/png");
  if (upload.backend !== "gcs") throw new Error("Expected GCS fixture mode");
  provider.objects.set(`photos/_incoming/${upload.assetId}`, {
    bucket: "photos", name: `_incoming/${upload.assetId}`, generation: String(++provider.generation),
    size: 100, contentType: "image/png", contentEncoding: null, crc32c: "AAAAAA==", md5Hash: null, binding: null,
  });
  return { id, assetId: upload.assetId };
}
async function createSaved() {
  const value = await prepare();
  await expect(createRecord(form(value.id, value.assetId))).rejects.toSatisfy((e: unknown) => isRedirectTo(e, `/records/${value.id}`));
  return value;
}
beforeAll(async () => {
  assertLocalSupabase(SUPABASE_URL, DB_URL);
  await db.connect();
  expect((await db.query("select public.get_media_storage_mode() mode")).rows[0].mode).toBe("supabase");
  await db.query("select public.set_media_storage_mode('frozen'); select public.set_media_storage_mode('gcs')");
  initialized = true;
});
afterAll(async () => {
  if (initialized) {
    await db.query("delete from public.daycare_records where id=any($1::uuid[])", [recordIds]);
    await db.query("update public.media_assets set state='deleted',deleted_at=now() where kind='photo' and entity_id=any($1::uuid[]) and state<>'deleted'", [recordIds]);
    await db.query("select public.set_media_storage_mode('frozen'); select public.set_media_storage_mode('supabase')");
  }
  await db.end();
});
beforeEach(() => {
  vi.clearAllMocks();
  provider.signUpload.mockResolvedValue({ url: "https://example.invalid/upload", headers: {}, expiresAt: "2999-01-01T00:00:00Z" });
  provider.stat.mockImplementation(async (ref: { bucket: string; name: string; generation?: string }) => {
    const value = provider.objects.get(`${ref.bucket}/${ref.name}`);
    return value && (!ref.generation || ref.generation === value.generation) ? value : null;
  });
  provider.publish.mockImplementation(async (input: { source: GcsMetadata; destinationName: string; binding: GcsBinding; expectedSize: number; contentType: string }) => {
    const source = provider.objects.get(`${input.source.bucket}/${input.source.name}`);
    if (!source) throw new Error("Synthetic source missing");
    const result = { ...source, name: input.destinationName, generation: String(++provider.generation), binding: input.binding };
    provider.objects.set(`${source.bucket}/${result.name}`, result);
    return result;
  });
  provider.signRead.mockImplementation(async (ref: GcsMetadata) => `https://example.invalid/read/${ref.generation}`);
  provider.remove.mockImplementation(async (ref: GcsMetadata) => {
    const key = `${ref.bucket}/${ref.name}`;
    if (provider.objects.get(key)?.generation === ref.generation) provider.objects.delete(key);
  });
});

describe("GCS application lifecycle over real user JWT RPCs", () => {
  it("reserves, publishes, signs and terminally deletes an exact photo reference", async () => {
    const { id, assetId } = await createSaved();
    const { rows } = await db.query("select state,generation,final_key from public.media_assets where id=$1", [assetId]);
    expect(rows[0].state).toBe("ready");
    expect(await createPhotoSignedUrls([assetId])).toEqual(new Map([[assetId, `https://example.invalid/read/${rows[0].generation}`]]));
    expect(provider.objects.has(`photos/_incoming/${assetId}`)).toBe(false);
    await deletePhoto(assetId, id);
    expect((await db.query("select state from public.media_assets where id=$1", [assetId])).rows[0].state).toBe("deleted");
    expect(provider.objects.has(`photos/${rows[0].final_key}`)).toBe(false);
    expect(await createPhotoSignedUrls([assetId])).toEqual(new Map());
  });
  it("does not sign a ready claim forged by calling the public RPC directly", async () => {
    const { id, assetId } = await prepare();
    await db.query("insert into public.daycare_records(id,owner_id,household_id) values($1,$2,$3)", [id, seed.users.aEditor, seed.householdA]);
    const client = await loginAs(PERSONAS.aEditor);
    const { error } = await client.rpc("commit_media_upload", { p_asset_id: assetId, p_generation: "999" });
    expect(error).toBeNull(); // This is a claim, deliberately not an attestation.
    expect(await createPhotoSignedUrls([assetId])).toEqual(new Map());
    expect(provider.signRead).not.toHaveBeenCalled();
  });
  it("refuses a GCS metadata binding that belongs to a different owner", async () => {
    const { assetId } = await createSaved();
    const asset = (await db.query("select final_key from public.media_assets where id=$1", [assetId])).rows[0];
    const key = `photos/${asset.final_key}`;
    const value = provider.objects.get(key)!;
    provider.objects.set(key, { ...value, binding: { ...value.binding!, ownerId: seed.users.bOwner } });
    await expect(createPhotoSignedUrls([assetId])).rejects.toThrow();
    expect(provider.signRead).not.toHaveBeenCalled();
  });
  it("keeps guest photo reads and reservations denied even when the record is guest-visible", async () => {
    const { id, assetId } = await createSaved();
    await db.query("update public.daycare_records set guest_visible=true where id=$1", [id]);
    await loginAs(PERSONAS.guestActive);
    expect(await createPhotoSignedUrls([assetId])).toEqual(new Map());
    await expect(beginMediaUpload({ kind: "photo", entityId: id, householdId: seed.householdA }, 100, "image/png")).rejects.toThrow();
    expect(provider.signRead).not.toHaveBeenCalled();
  });
  it("preserves GCS reads during a post-cutover write freeze", async () => {
    const { assetId } = await createSaved();
    await db.query("select public.set_media_storage_mode('frozen')");
    try {
      expect(await getMediaReadBackend()).toBe("gcs");
      await expect(requireMediaWrites()).rejects.toThrow("切り替えています");
      expect((await createPhotoSignedUrls([assetId])).has(assetId)).toBe(true);
    } finally { await db.query("select public.set_media_storage_mode('gcs')"); }
  });
  it("opens the saved record for recovery if first publication fails", async () => {
    const { id, assetId } = await prepare();
    provider.publish.mockRejectedValueOnce(new Error("Synthetic copy failure"));
    await expect(createRecord(form(id, assetId))).rejects.toSatisfy((e: unknown) => isRedirectTo(e, `/records/${id}?edit=1&save_notice=partial`));
    expect((await db.query("select count(*)::int n from public.daycare_records where id=$1", [id])).rows[0].n).toBe(1);
    expect((await db.query("select count(*)::int n from public.record_photos where record_id=$1", [id])).rows[0].n).toBe(0);
    // The recovery page uses update, so it cannot hit duplicate-create forever.
    await expect(updateRecord(id, form(id, assetId))).rejects.toSatisfy((e: unknown) => isRedirectTo(e, `/records/${id}`));
    expect((await db.query("select count(*)::int n from public.record_photos where record_id=$1", [id])).rows[0].n).toBe(1);
  });
  it("revalidates the committed deletion even if provider cleanup fails", async () => {
    const { id, assetId } = await createSaved();
    vi.mocked(revalidatePath).mockClear();
    provider.remove.mockRejectedValueOnce(new Error("Synthetic delete failure"));
    await expect(deletePhoto(assetId, id)).rejects.toThrow("Synthetic delete failure");
    expect((await db.query("select state from public.media_assets where id=$1", [assetId])).rows[0].state).toBe("deleted");
    expect(revalidatePath).toHaveBeenCalledWith(`/records/${id}`);
    expect(revalidatePath).toHaveBeenCalledWith("/gallery");
    expect(await createPhotoSignedUrls([assetId])).toEqual(new Map());
  });
});
