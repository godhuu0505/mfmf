import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ createClient: vi.fn(), getRole: vi.fn(), remove: vi.fn(), revalidate: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mock.createClient }));
vi.mock("next/cache", () => ({ revalidatePath: mock.revalidate }));
vi.mock("next/navigation", () => ({ redirect: () => { throw new Error("redirect"); } }));
vi.mock("@/lib/household", () => ({
  getRoleInHousehold: mock.getRole,
  canEdit: (role: string) => ["owner", "editor"].includes(role),
  requireEditableHousehold: vi.fn(), householdScopeFilter: vi.fn(),
}));
import { deletePhoto, deleteRecord } from "@/app/(app)/records/actions";
import { deletePet, updatePetAvatar } from "@/app/(app)/pets/actions";

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HH = "11111111-1111-4111-8111-111111111111";
const RECORD = "33333333-3333-4333-8333-333333333333";
const OTHER = "22222222-2222-4222-8222-222222222222";
const PHOTO = "44444444-4444-4444-8444-444444444444";
const PET = "55555555-5555-4555-8555-555555555555";
let photo: { record_id: string; storage_path: string } | null;
let mutations: string[];
let queries: { table: string; filters: [string, string][] }[];

beforeEach(() => {
  vi.clearAllMocks();
  photo = { record_id: RECORD, storage_path: `${HH}/${RECORD}/photo.jpg` };
  mutations = []; queries = [];
  mock.getRole.mockResolvedValue("editor");
  mock.remove.mockResolvedValue({ error: null });
  const from = (table: string) => {
    const filters: [string, string][] = [];
    queries.push({ table, filters });
    const query = {
      select: () => query,
      eq: (key: string, value: string) => { filters.push([key, value]); return query; },
      delete: () => { mutations.push(`delete:${table}`); return query; },
      update: () => { mutations.push(`update:${table}`); return query; },
      single: async () => ({ data: photo, error: null }),
      maybeSingle: async () => ({ data: { household_id: HH, avatar_path: `${HH}/avatars/old.jpg` }, error: null }),
      then: (resolve: (value: object) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve),
    };
    return query;
  };
  mock.createClient.mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) },
    from, storage: { from: () => ({ remove: mock.remove }) },
    rpc: () => { mutations.push("rpc"); return Promise.resolve({ error: null }); },
  });
});

describe("media mutation row authorization", () => {
  it("binds the selected photo to the requested record before storage deletion", async () => {
    await deletePhoto(PHOTO, RECORD);
    expect(queries[0]).toEqual({ table: "record_photos", filters: [["id", PHOTO], ["record_id", RECORD]] });
    expect(queries[1]).toEqual({ table: "daycare_records", filters: [["id", RECORD]] });
    expect(mock.getRole).toHaveBeenCalledWith(expect.anything(), USER, HH);
    expect(mock.remove).toHaveBeenCalledWith([`${HH}/${RECORD}/photo.jpg`]);
    expect(mutations).toEqual(["delete:record_photos"]);
  });
  it("rejects a photo from another record even if the supplied record is editable", async () => {
    photo!.record_id = OTHER;
    await expect(deletePhoto(PHOTO, RECORD)).rejects.toThrow("写真が見つかりません");
    expect(mock.getRole).not.toHaveBeenCalled(); expect(mock.remove).not.toHaveBeenCalled();
    expect(mutations).toEqual([]);
  });
  it("rejects an invisible photo without any storage mutation", async () => {
    photo = null;
    await expect(deletePhoto(PHOTO, RECORD)).rejects.toThrow("写真が見つかりません");
    expect(mock.remove).not.toHaveBeenCalled(); expect(mutations).toEqual([]);
  });
  it.each([null, "viewer"])("rejects photo deletion with role %s before storage mutation", async (role) => {
    mock.getRole.mockResolvedValue(role);
    await expect(deletePhoto(PHOTO, RECORD)).rejects.toThrow();
    expect(mock.remove).not.toHaveBeenCalled(); expect(mutations).toEqual([]);
  });
  it.each(["record", "pet", "pet-avatar"])("rejects guest-visible %s mutation when membership is absent", async (kind) => {
    mock.getRole.mockResolvedValue(null);
    const form = new FormData(); form.set("avatar_path", "");
    const operation = kind === "record" ? deleteRecord(RECORD) : kind === "pet" ? deletePet(PET) : updatePetAvatar(PET, form);
    await expect(operation).rejects.toThrow("この世帯のメンバーではありません");
    expect(mock.remove).not.toHaveBeenCalled(); expect(mutations).toEqual([]);
  });
});
