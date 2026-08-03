import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client as PgClient } from "pg";
import { PERSONAS } from "./env";
import { setHouseholdCookie } from "./mockState";
import {
  asAnonymous,
  expectLoginRedirect,
  loadSeed,
  loginAs,
  marker,
  newDb,
} from "./testKit";

// pets/actions.ts（3 アクション）の認可検証。
// 既存ペットへの操作は「ペットが属する世帯」基準（records と同じ D16 の不変条件）。

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

import { createPet, deletePet, updatePet } from "@/app/pets/actions";

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

function petForm(name: string, householdId?: string): FormData {
  const fd = new FormData();
  fd.set("name", name);
  if (householdId) fd.set("household_id", householdId);
  return fd;
}

async function insertPetInA(name: string): Promise<string> {
  const { rows } = await db.query(
    `insert into public.pets (owner_id, household_id, name)
     values ($1, $2, $3) returning id`,
    [seed.users.aOwner, seed.householdA, name],
  );
  return rows[0].id as string;
}

async function petById(id: string) {
  const { rows } = await db.query(
    "select id, name, household_id from public.pets where id = $1",
    [id],
  );
  return rows[0] ?? null;
}

describe("未ログインの拒否", () => {
  it("3 アクションすべて /login へ redirect", async () => {
    asAnonymous();
    await expectLoginRedirect(createPet(petForm("x", seed.householdA)));
    asAnonymous();
    await expectLoginRedirect(updatePet(crypto.randomUUID(), petForm("x")));
    asAnonymous();
    await expectLoginRedirect(deletePet(crypto.randomUUID()));
  });
});

describe("createPet: フォームの世帯基準", () => {
  it("editor はフォームの世帯に追加できる", async () => {
    await loginAs(PERSONAS.aEditor);
    const name = marker("pet");
    await createPet(petForm(name, seed.householdA));
    const { rows } = await db.query(
      "select household_id from public.pets where name = $1",
      [name],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].household_id).toBe(seed.householdA);
  });

  it("viewer / 非メンバー世帯 / 空の名前は拒否される", async () => {
    await loginAs(PERSONAS.aViewer);
    const name1 = marker("pet-viewer");
    await expect(createPet(petForm(name1, seed.householdA))).rejects.toThrow(/閲覧のみ/);

    await loginAs(PERSONAS.aEditor);
    const name2 = marker("pet-cross");
    await expect(createPet(petForm(name2, seed.householdB))).rejects.toThrow(
      /この世帯のメンバーではありません/,
    );
    await expect(createPet(petForm("", seed.householdA))).rejects.toThrow(
      /名前を入力/,
    );

    const { rows } = await db.query(
      "select 1 from public.pets where name in ($1, $2)",
      [name1, name2],
    );
    expect(rows).toHaveLength(0);
  });
});

describe("updatePet / deletePet: 対象ペットの世帯基準（Cookie 非依存）", () => {
  it("A/B 兼任者は Cookie=B のまま A のペットを更新・削除できる", async () => {
    const petId = await insertPetInA(marker("pet-ab"));
    await loginAs(PERSONAS.abEditor);
    setHouseholdCookie(seed.householdB);

    const newName = marker("pet-renamed");
    await updatePet(petId, petForm(newName));
    const after = await petById(petId);
    expect(after.name).toBe(newName);
    expect(after.household_id).toBe(seed.householdA); // 世帯は移動しない

    await deletePet(petId);
    expect(await petById(petId)).toBeNull();
  });

  it("非メンバーにはペットの存在ごと見えない", async () => {
    const petId = await insertPetInA(marker("pet-battack"));
    await loginAs(PERSONAS.bOwner);
    await expect(updatePet(petId, petForm("乗っ取り"))).rejects.toThrow(
      /見つかりません/,
    );
    await expect(deletePet(petId)).rejects.toThrow(/見つかりません/);
    expect(await petById(petId)).not.toBeNull();
  });

  it("viewer は更新・削除できない", async () => {
    const petId = await insertPetInA(marker("pet-viewer-target"));
    await loginAs(PERSONAS.aViewer);
    await expect(updatePet(petId, petForm("書き換え"))).rejects.toThrow(/閲覧のみ/);
    await expect(deletePet(petId)).rejects.toThrow(/閲覧のみ/);
    expect(await petById(petId)).not.toBeNull();
  });
});
