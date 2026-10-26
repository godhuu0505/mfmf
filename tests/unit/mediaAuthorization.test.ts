import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ createClient: vi.fn(), getRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mock.createClient }));
vi.mock("@/lib/household", () => ({ getRoleInHousehold: mock.getRole }));
import { assertAuthorizedMediaDescriptor, authorizeAvatarRead, authorizeAvatarReads, authorizePhotoReads } from "@/lib/mediaAuthorization";

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AUTHOR = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HH = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const RECORD = "33333333-3333-4333-8333-333333333333";
const PHOTO = "44444444-4444-4444-8444-444444444444";
const PET = "55555555-5555-4555-8555-555555555555";
const FAILURE = "画像へのアクセスを確認できませんでした";
type Row = Record<string, unknown>;
let rows: Record<string, Row[]>;
let failures: Set<string>;
let from: ReturnType<typeof vi.fn>;
let getUser: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  rows = {
    record_photos: [{ id: PHOTO, record_id: RECORD, household_id: HH, storage_path: `${HH}/${RECORD}/file.jpg` }],
    daycare_records: [{ id: RECORD, household_id: HH, owner_id: AUTHOR }],
    profiles: [{ owner_id: USER, avatar_path: `${USER}/avatars/user.jpg` }],
    households: [{ id: HH, avatar_path: `${HH}/avatars/household.jpg` }],
    pets: [{ id: PET, household_id: HH, owner_id: AUTHOR, avatar_path: `${HH}/avatars/pet.jpg` }],
  };
  failures = new Set();
  getUser = vi.fn().mockResolvedValue({ data: { user: { id: USER } }, error: null });
  from = vi.fn((table: string) => {
    let selected = rows[table] ?? [];
    const query = {
      select: vi.fn(() => query),
      in: vi.fn((column: string, values: string[]) => {
        selected = selected.filter((row) => values.includes(String(row[column])));
        return query;
      }),
      returns: vi.fn(async () => failures.has(table)
        ? { data: null, error: { message: "PRIVATE_DATABASE_ERROR" } }
        : { data: structuredClone(selected), error: null }),
    };
    return query;
  });
  mock.createClient.mockResolvedValue({ auth: { getUser }, from });
  mock.getRole.mockImplementation(async (_client, actor, household) => actor === USER && household === HH ? "viewer" : null);
});

describe("photo authorization from IDs and parent rows", () => {
  it("allows a viewer's real household row and binds its actual author, not the caller", async () => {
    const [descriptor] = await authorizePhotoReads([PHOTO, PHOTO.toUpperCase()]);
    expect(descriptor).toMatchObject({ kind: "photo", bucket: "daycare-photos", actorId: USER,
      photoId: PHOTO, entityId: PHOTO, recordId: RECORD, householdId: HH, ownerId: AUTHOR, path: `${HH}/${RECORD}/file.jpg` });
    expect(mock.getRole).toHaveBeenCalledWith(expect.anything(), USER, HH);
    expect(() => assertAuthorizedMediaDescriptor(descriptor)).not.toThrow();
    expect(Object.isFrozen(descriptor)).toBe(true);
  });
  it("retains departed creators' legacy owner paths for remaining household members", async () => {
    rows.record_photos[0].storage_path = `${AUTHOR.toUpperCase()}/${RECORD}/legacy.jpg`;
    const [descriptor] = await authorizePhotoReads([PHOTO]);
    expect(descriptor.path).toBe(rows.record_photos[0].storage_path);
    expect(mock.getRole).not.toHaveBeenCalledWith(expect.anything(), AUTHOR, HH);
  });
  it("does not treat being the creator or a guest-visible parent as membership", async () => {
    mock.getRole.mockResolvedValue(null);
    rows.daycare_records[0].owner_id = USER;
    rows.record_photos[0].storage_path = `${USER}/${RECORD}/legacy.jpg`;
    expect(await authorizePhotoReads([PHOTO])).toEqual([]);
  });
  it.each([
    `${OTHER}/${RECORD}/file.jpg`, `${HH}/${OTHER}/file.jpg`, `${HH}/${RECORD}/../file.jpg`,
    `${HH}/${RECORD}/..`, `${HH}/${RECORD}/.`, `${HH}/${RECORD}/`, `${HH}/${RECORD}/file%2F.jpg`,
    `${HH}/${RECORD}/file\\.jpg`, `${HH}/${RECORD}/file?token=private`, `${HH}/${RECORD}/file\n.jpg`,
    `https://private.invalid/${HH}/${RECORD}/file.jpg`, `${HH}/${RECORD}/${"a".repeat(1025)}`,
  ])("does not sign an injected or ambiguous stored path", async (path) => {
    rows.record_photos[0].storage_path = path;
    expect(await authorizePhotoReads([PHOTO])).toEqual([]);
  });
  it("rejects mismatched child-household metadata rather than trusting its scope", async () => {
    rows.record_photos[0].household_id = OTHER;
    expect(await authorizePhotoReads([PHOTO])).toEqual([]);
  });
  it.each(["record_photos", "daycare_records"])("omits a missing or RLS-invisible %s row", async (table) => {
    rows[table] = [];
    expect(await authorizePhotoReads([PHOTO])).toEqual([]);
  });
  it("keeps requested order and does not authorize other IDs returned alongside them", async () => {
    rows.record_photos.push({ ...rows.record_photos[0], id: OTHER });
    expect((await authorizePhotoReads([PHOTO])).map((row) => row.photoId)).toEqual([PHOTO]);
  });
});

describe("avatar authorization keeps personal and household scopes separate", () => {
  it("allows a person's own avatar even with no household membership", async () => {
    mock.getRole.mockResolvedValue(null);
    expect(await authorizeAvatarRead("profile", USER)).toMatchObject({ kind: "profile", entityId: USER,
      ownerId: USER, householdId: null, bucket: "avatars", path: `${USER}/avatars/user.jpg` });
    expect(mock.getRole).not.toHaveBeenCalled();
  });
  it("never reads another person's profile even when both share a household", async () => {
    rows.profiles.push({ owner_id: AUTHOR, avatar_path: `${AUTHOR}/avatars/other.jpg` });
    expect(await authorizeAvatarRead("profile", AUTHOR)).toBeNull();
    expect(from).not.toHaveBeenCalled();
  });
  it("authorizes household and pet avatars for viewers and retains target identities", async () => {
    const descriptors = await authorizeAvatarReads([{ kind: "household", entityId: HH }, { kind: "pet", entityId: PET }]);
    expect(descriptors.map(({ kind, entityId }) => ({ kind, entityId }))).toEqual([
      { kind: "household", entityId: HH }, { kind: "pet", entityId: PET },
    ]);
    expect(descriptors.every((descriptor) => descriptor.householdId === HH)).toBe(true);
    expect(mock.getRole).toHaveBeenCalledOnce();
  });
  it("rejects a guest-visible pet when there is no household membership", async () => {
    mock.getRole.mockResolvedValue(null);
    expect(await authorizeAvatarRead("pet", PET)).toBeNull();
  });
  it.each(["profiles", "households", "pets"])("rejects another scope injected into %s.avatar_path", async (table) => {
    rows[table][0].avatar_path = `${OTHER}/avatars/victim.jpg`;
    const targets = { profiles: ["profile", USER], households: ["household", HH], pets: ["pet", PET] } as const;
    const [kind, id] = targets[table as keyof typeof targets];
    expect(await authorizeAvatarRead(kind, id)).toBeNull();
  });
  it.each([null, `${USER}/${RECORD}/photo.jpg`, `${USER}/avatars/../victim.jpg`, `${USER}/avatars/a%2f.jpg`, "https://google.example/avatar"])("does not convert null, URLs or malformed paths into descriptors", async (path) => {
    rows.profiles[0].avatar_path = path;
    expect(await authorizeAvatarRead("profile", USER)).toBeNull();
  });
});

describe("authorization boundary failures", () => {
  it.each([null, { id: USER }])("requires successful getUser before querying rows", async (user) => {
    getUser.mockResolvedValue({ data: { user }, error: { message: "PRIVATE_AUTH_ERROR" } });
    await expect(authorizePhotoReads([PHOTO])).rejects.toThrow(FAILURE);
    await expect(authorizeAvatarRead("profile", USER)).rejects.toThrow(FAILURE);
    expect(from).not.toHaveBeenCalled();
  });
  it("checks authentication even for an empty request", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: null });
    await expect(authorizePhotoReads([])).rejects.toThrow(FAILURE);
    await expect(authorizeAvatarReads([])).rejects.toThrow(FAILURE);
  });
  it.each(["record_photos", "daycare_records", "profiles", "households", "pets"])("withholds database details on %s failure", async (table) => {
    failures.add(table);
    const promise = table === "record_photos" || table === "daycare_records" ? authorizePhotoReads([PHOTO])
      : authorizeAvatarRead(table === "profiles" ? "profile" : table === "households" ? "household" : "pet",
        table === "profiles" ? USER : table === "households" ? HH : PET);
    await expect(promise).rejects.toThrow(new Error(FAILURE));
  });
  it("withholds thrown network details", async () => {
    getUser.mockRejectedValue(new Error("PRIVATE_NETWORK_DETAILS"));
    await expect(authorizePhotoReads([PHOTO])).rejects.toThrow(new Error(FAILURE));
  });
  it.each([["not-an-id"], Array(1001).fill(PHOTO)])("rejects invalid or unbounded inputs before querying rows", async (input) => {
    await expect(authorizePhotoReads(input)).rejects.toThrow(FAILURE);
    expect(from).not.toHaveBeenCalled();
  });
  it("rejects a caller's copied or forged descriptor", async () => {
    const [descriptor] = await authorizePhotoReads([PHOTO]);
    for (const value of [JSON.parse(JSON.stringify(descriptor)), { ...descriptor }, null, "path"]) {
      expect(() => assertAuthorizedMediaDescriptor(value)).toThrow(FAILURE);
    }
  });
});
