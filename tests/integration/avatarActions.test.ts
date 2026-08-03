import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Client as PgClient } from "pg";
import { PERSONAS } from "./env";
import { setHouseholdCookie } from "./mockState";
import {
  asAnonymous,
  expectLoginRedirect,
  loadSeed,
  loginAs,
  newDb,
} from "./testKit";

// アバター 3 アクション（updatePetAvatar / updateHouseholdAvatar / updateUserAvatar）の
// 認可検証（Integration 層 / D30）。見るのは「どの認可ヘルパーで・どの scope を基準に
// 判定したか」: pet は「ペットが属する世帯」の editor 以上（D16 の不変条件・Cookie 非依存）、
// household は「対象世帯の owner」、user は本人のみ。avatar_path の scope 検証
// （isAvatarPathForScope）が越境パスの紐付けを落とすことも ground truth（postgres 直）で見る。

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", async () => {
  const { RedirectSentinel } = await import("./mockState");
  return {
    redirect: (url: string) => {
      throw new RedirectSentinel(url);
    },
  };
});
vi.mock("next/headers", async () => {
  const { fakeCookies } = await import("./mockState");
  return { cookies: async () => fakeCookies };
});
vi.mock("@/lib/supabase/server", async () => {
  const { getServerClient } = await import("./mockState");
  return { createClient: async () => getServerClient() };
});

import { updatePetAvatar } from "@/app/pets/actions";
import { updateHouseholdAvatar, updateUserAvatar } from "@/app/settings/actions";
import { buildAvatarPath } from "@/lib/storagePath";
import { AVATAR_BUCKET } from "@/types/database";

const seed = loadSeed();
let db: PgClient;

beforeAll(async () => {
  db = newDb();
  await db.connect();
});

afterAll(async () => {
  await db.end();
});

beforeEach(() => {
  setHouseholdCookie(null);
});

function avatarForm(path: string): FormData {
  const fd = new FormData();
  fd.set("avatar_path", path);
  return fd;
}

// Storage fixture はペルソナの実クライアントで upload する（Storage RLS の insert も
// 同時に本物で通す）。パスは uuid 入りで実行ごとに一意 = 再実行しても衝突しない。
async function uploadAvatarAs(
  client: SupabaseClient,
  scopeId: string,
): Promise<string> {
  const path = buildAvatarPath(scopeId, "avatar.jpg");
  const body = new Blob([new Uint8Array(256).fill(0xab)], { type: "image/jpeg" });
  const { error } = await client.storage
    .from(AVATAR_BUCKET)
    .upload(path, body, { contentType: "image/jpeg" });
  if (error) throw new Error(`fixture の upload に失敗: ${error.message}`);
  return path;
}

// ground truth は postgres 直（RLS 迂回）で確認する
async function storageHas(path: string): Promise<boolean> {
  const { rows } = await db.query(
    "select 1 from storage.objects where bucket_id = $1 and name = $2",
    [AVATAR_BUCKET, path],
  );
  return rows.length > 0;
}

async function petAvatarPath(petId: string): Promise<string | null> {
  const { rows } = await db.query(
    "select avatar_path from public.pets where id = $1",
    [petId],
  );
  return rows[0]?.avatar_path ?? null;
}

async function householdAvatarPath(householdId: string): Promise<string | null> {
  const { rows } = await db.query(
    "select avatar_path from public.households where id = $1",
    [householdId],
  );
  return rows[0]?.avatar_path ?? null;
}

async function profileAvatarPath(userId: string): Promise<string | null> {
  const { rows } = await db.query(
    "select avatar_path from public.profiles where owner_id = $1",
    [userId],
  );
  return rows[0]?.avatar_path ?? null;
}

describe("未ログインの拒否", () => {
  it("3 アクションすべて /login へ redirect", async () => {
    const path = `${seed.householdA}/avatars/x.jpg`;
    asAnonymous();
    await expectLoginRedirect(updatePetAvatar(seed.petA, avatarForm(path)));
    asAnonymous();
    await expectLoginRedirect(
      updateHouseholdAvatar(seed.householdA, avatarForm(path)),
    );
    asAnonymous();
    await expectLoginRedirect(
      updateUserAvatar(avatarForm(`${seed.users.aViewer}/avatars/x.jpg`)),
    );
  });
});

describe("viewer は pet / household のアバターを変更できない", () => {
  it("updatePetAvatar は viewer を拒否する", async () => {
    const before = await petAvatarPath(seed.petA);
    await loginAs(PERSONAS.aViewer);
    await expect(
      updatePetAvatar(seed.petA, avatarForm(`${seed.householdA}/avatars/v.jpg`)),
    ).rejects.toThrow(/閲覧のみ/);
    expect(await petAvatarPath(seed.petA)).toBe(before);
  });

  it("updateHouseholdAvatar は viewer を拒否する（owner のみのため）", async () => {
    const before = await householdAvatarPath(seed.householdA);
    await loginAs(PERSONAS.aViewer);
    await expect(
      updateHouseholdAvatar(
        seed.householdA,
        avatarForm(`${seed.householdA}/avatars/v.jpg`),
      ),
    ).rejects.toThrow(/owner のみ/);
    expect(await householdAvatarPath(seed.householdA)).toBe(before);
  });
});

describe("updateHouseholdAvatar は「対象世帯の owner」のみ", () => {
  it("editor / 他世帯の owner も拒否される", async () => {
    const before = await householdAvatarPath(seed.householdA);
    for (const persona of [PERSONAS.aEditor, PERSONAS.bOwner]) {
      await loginAs(persona);
      await expect(
        updateHouseholdAvatar(
          seed.householdA,
          avatarForm(`${seed.householdA}/avatars/e.jpg`),
        ),
      ).rejects.toThrow(/owner のみ/);
    }
    expect(await householdAvatarPath(seed.householdA)).toBe(before);
  });

  it("owner は設定・差し替え（旧オブジェクト片付け）・削除ができる", async () => {
    const client = await loginAs(PERSONAS.aOwner);

    const first = await uploadAvatarAs(client, seed.householdA);
    await updateHouseholdAvatar(seed.householdA, avatarForm(first));
    expect(await householdAvatarPath(seed.householdA)).toBe(first);

    // 差し替え: 旧オブジェクトが Storage から消える（オーファン防止）
    const second = await uploadAvatarAs(client, seed.householdA);
    await updateHouseholdAvatar(seed.householdA, avatarForm(second));
    expect(await householdAvatarPath(seed.householdA)).toBe(second);
    expect(await storageHas(first)).toBe(false);
    expect(await storageHas(second)).toBe(true);

    // 削除（空文字）: 列は null、オブジェクトも片付く
    await updateHouseholdAvatar(seed.householdA, avatarForm(""));
    expect(await householdAvatarPath(seed.householdA)).toBeNull();
    expect(await storageHas(second)).toBe(false);
  });
});

describe("越境パスの拒否（avatar_path の scope 検証）", () => {
  it("updatePetAvatar: 他世帯・自分の uid スコープのパスは紐付けられない", async () => {
    const before = await petAvatarPath(seed.petA);
    await loginAs(PERSONAS.aEditor);
    // 他世帯（B）のスコープ
    await expect(
      updatePetAvatar(seed.petA, avatarForm(`${seed.householdB}/avatars/x.jpg`)),
    ).rejects.toThrow(/不正なアバターパス/);
    // 自分の uid スコープ（ペットのアバターは「ペットの世帯」スコープでなければならない）
    await expect(
      updatePetAvatar(seed.petA, avatarForm(`${seed.users.aEditor}/avatars/x.jpg`)),
    ).rejects.toThrow(/不正なアバターパス/);
    expect(await petAvatarPath(seed.petA)).toBe(before);
  });

  it("updateHouseholdAvatar: 他世帯スコープのパスは紐付けられない", async () => {
    const before = await householdAvatarPath(seed.householdA);
    await loginAs(PERSONAS.aOwner);
    await expect(
      updateHouseholdAvatar(
        seed.householdA,
        avatarForm(`${seed.householdB}/avatars/x.jpg`),
      ),
    ).rejects.toThrow(/不正なアバターパス/);
    expect(await householdAvatarPath(seed.householdA)).toBe(before);
  });

  it("updateUserAvatar: 他人の uid・世帯スコープのパスは紐付けられない", async () => {
    const before = await profileAvatarPath(seed.users.aEditor);
    await loginAs(PERSONAS.aEditor);
    // 他人（aOwner）の uid スコープ
    await expect(
      updateUserAvatar(avatarForm(`${seed.users.aOwner}/avatars/x.jpg`)),
    ).rejects.toThrow(/不正なアバターパス/);
    // 世帯スコープ（ユーザーアバターは本人の uid スコープでなければならない）
    await expect(
      updateUserAvatar(avatarForm(`${seed.householdA}/avatars/x.jpg`)),
    ).rejects.toThrow(/不正なアバターパス/);
    expect(await profileAvatarPath(seed.users.aEditor)).toBe(before);
  });

  it("非メンバーにはペットの存在ごと見えない", async () => {
    const before = await petAvatarPath(seed.petA);
    await loginAs(PERSONAS.bOwner);
    await expect(
      updatePetAvatar(seed.petA, avatarForm(`${seed.householdA}/avatars/x.jpg`)),
    ).rejects.toThrow(/見つかりません/);
    expect(await petAvatarPath(seed.petA)).toBe(before);
  });
});

describe("updatePetAvatar: 対象ペットの世帯基準（Cookie 非依存）", () => {
  it("A/B 兼任者は Cookie=B のまま A のペットのアバターを設定・差し替え・削除できる", async () => {
    const client = await loginAs(PERSONAS.abEditor);
    setHouseholdCookie(seed.householdB);

    const first = await uploadAvatarAs(client, seed.householdA);
    await updatePetAvatar(seed.petA, avatarForm(first));
    expect(await petAvatarPath(seed.petA)).toBe(first);

    // 差し替え: 旧オブジェクトが Storage から消える（オーファン防止）
    const second = await uploadAvatarAs(client, seed.householdA);
    await updatePetAvatar(seed.petA, avatarForm(second));
    expect(await petAvatarPath(seed.petA)).toBe(second);
    expect(await storageHas(first)).toBe(false);
    expect(await storageHas(second)).toBe(true);

    // 削除（空文字）
    await updatePetAvatar(seed.petA, avatarForm(""));
    expect(await petAvatarPath(seed.petA)).toBeNull();
    expect(await storageHas(second)).toBe(false);
  });
});

describe("updateUserAvatar: 本人の uid スコープ", () => {
  it("本人は設定・差し替え（旧オブジェクト片付け）・削除ができる", async () => {
    const client = await loginAs(PERSONAS.aEditor);

    const first = await uploadAvatarAs(client, seed.users.aEditor);
    await updateUserAvatar(avatarForm(first));
    expect(await profileAvatarPath(seed.users.aEditor)).toBe(first);

    const second = await uploadAvatarAs(client, seed.users.aEditor);
    await updateUserAvatar(avatarForm(second));
    expect(await profileAvatarPath(seed.users.aEditor)).toBe(second);
    expect(await storageHas(first)).toBe(false);
    expect(await storageHas(second)).toBe(true);

    await updateUserAvatar(avatarForm(""));
    expect(await profileAvatarPath(seed.users.aEditor)).toBeNull();
    expect(await storageHas(second)).toBe(false);
  });
});
