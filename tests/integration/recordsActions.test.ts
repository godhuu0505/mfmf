import { readFileSync } from "node:fs";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createClient as createSupabaseClient,
  type SupabaseClient,
} from "@supabase/supabase-js";
import { Client as PgClient } from "pg";
import {
  ANON_KEY,
  DB_URL,
  PERSONAS,
  SEED_FILE,
  SUPABASE_URL,
  type Persona,
  type SeedIds,
} from "./env";
import {
  RedirectSentinel,
  setHouseholdCookie,
  setServerClient,
} from "./mockState";

// records/actions.ts の Server Action 認可（Integration 層 / D30）。
// pgTAP は「DB が守っているか」を見るが、この層は「アプリがどの世帯を基準に
// 認可したか」を見る —— requireEditableHousehold と getCurrentHouseholdId の
// 取り違え（CLAUDE.md 自身が 2 度間違えたと書く D16 の失敗）はここでしか捕まらない。

// ---- Next インフラの継ぎ目だけをモックする（認可・RLS・PostgREST は本物） ----
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

import {
  createQuickRecord,
  createRecord,
  deletePhoto,
  deleteRecord,
  setRecordGuestVisible,
  updateRecord,
} from "@/app/records/actions";

const seed: SeedIds = JSON.parse(readFileSync(SEED_FILE, "utf8"));

let db: PgClient;
const clients = new Map<string, SupabaseClient>();

function newClient() {
  return createSupabaseClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// このペルソナとして Server Action を呼ぶ状態にする
async function loginAs(persona: Persona): Promise<SupabaseClient> {
  let client = clients.get(persona.email);
  if (!client) {
    client = newClient();
    const { error } = await client.auth.signInWithPassword(persona);
    if (error) throw new Error(`${persona.email}: ${error.message}`);
    clients.set(persona.email, client);
  }
  setServerClient(client);
  return client;
}

function asAnonymous() {
  setServerClient(newClient());
}

// ---- FormData fixture ----

function todayISO(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function recordForm(householdId: string | null, body: string): FormData {
  const fd = new FormData();
  fd.set("record_date", todayISO());
  fd.set("source", "home");
  fd.set("author", "integration");
  fd.set("body", body);
  if (householdId) fd.set("household_id", householdId);
  return fd;
}

function fullRecordForm(
  householdId: string | null,
  recordId: string,
  body: string,
): FormData {
  const fd = recordForm(householdId, body);
  fd.set("record_id", recordId);
  return fd;
}

function marker(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

// ---- ground truth は RLS を通さず postgres 直で見る（見えないだけ、を排除） ----

async function findRecordByBody(body: string) {
  const { rows } = await db.query(
    "select id, household_id, owner_id, source, guest_visible from public.daycare_records where body = $1",
    [body],
  );
  return rows;
}

async function recordById(id: string) {
  const { rows } = await db.query(
    "select id, household_id, body, guest_visible from public.daycare_records where id = $1",
    [id],
  );
  return rows[0] ?? null;
}

// 世帯 A に記録を 1 件つくる（fixture。作成経路自体は別テストで検証済みの createQuickRecord ではなく
// DB 直挿入にして、更新/削除テストの前提を作成系の成否と独立させる）
async function insertRecordInA(body: string): Promise<string> {
  const { rows } = await db.query(
    `insert into public.daycare_records (owner_id, household_id, record_date, source, author, body)
     values ($1, $2, current_date, 'home', 'fixture', $3) returning id`,
    [seed.users.aOwner, seed.householdA, body],
  );
  return rows[0].id as string;
}

// instanceof はモジュールの二重解決で偽陰性になり得るため name で判定する
function isRedirectTo(e: unknown, url: string): boolean {
  return (
    e instanceof Error &&
    e.name === "RedirectSentinel" &&
    (e as RedirectSentinel).url === url
  );
}

async function expectLoginRedirect(p: Promise<unknown>) {
  await expect(p).rejects.toSatisfy((e: unknown) => isRedirectTo(e, "/login"));
}

// 成功時に redirect() で終わるアクション用（redirect も「成功の合図」）
async function expectRedirectTo(p: Promise<unknown>, url: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => isRedirectTo(e, url));
}

beforeAll(async () => {
  db = new PgClient({ connectionString: DB_URL });
  await db.connect();
});

afterAll(async () => {
  await db.end();
});

beforeEach(() => {
  setHouseholdCookie(null);
});

// ---------------------------------------------------------------------------

describe("不変条件1: 全 Server Action が未ログインを /login へ redirect する", () => {
  it("6 アクションすべて", async () => {
    asAnonymous();
    await expectLoginRedirect(createQuickRecord(recordForm(seed.householdA, "x")));
    asAnonymous();
    await expectLoginRedirect(
      createRecord(fullRecordForm(seed.householdA, crypto.randomUUID(), "x")),
    );
    asAnonymous();
    await expectLoginRedirect(
      updateRecord(crypto.randomUUID(), recordForm(null, "x")),
    );
    asAnonymous();
    await expectLoginRedirect(deleteRecord(crypto.randomUUID()));
    asAnonymous();
    await expectLoginRedirect(
      deletePhoto(crypto.randomUUID(), crypto.randomUUID()),
    );
    asAnonymous();
    await expectLoginRedirect(
      setRecordGuestVisible(crypto.randomUUID(), true),
    );
  });
});

describe("不変条件3: viewer は書き込み系を呼べない", () => {
  it("createQuickRecord / createRecord は viewer を分かりやすく拒否し、行を作らない", async () => {
    await loginAs(PERSONAS.aViewer);
    const body1 = marker("viewer-quick");
    await expect(
      createQuickRecord(recordForm(seed.householdA, body1)),
    ).rejects.toThrow(/閲覧のみ/);
    expect(await findRecordByBody(body1)).toHaveLength(0);

    const body2 = marker("viewer-full");
    await expect(
      createRecord(fullRecordForm(seed.householdA, crypto.randomUUID(), body2)),
    ).rejects.toThrow(/閲覧のみ/);
    expect(await findRecordByBody(body2)).toHaveLength(0);
  });

  it("updateRecord / deleteRecord / setRecordGuestVisible / deletePhoto も拒否する", async () => {
    const body = marker("viewer-target");
    const recordId = await insertRecordInA(body);
    const { rows: photoRows } = await db.query(
      `insert into public.record_photos (record_id, storage_path, household_id)
       values ($1, $2, $3) returning id`,
      [recordId, `${seed.householdA}/${recordId}/x.jpg`, seed.householdA],
    );
    const photoId = photoRows[0].id as string;

    await loginAs(PERSONAS.aViewer);
    await expect(
      updateRecord(recordId, recordForm(null, "書き換え")),
    ).rejects.toThrow(/閲覧のみ/);
    await expect(deleteRecord(recordId)).rejects.toThrow(/閲覧のみ/);
    await expect(setRecordGuestVisible(recordId, true)).rejects.toThrow(/閲覧のみ/);
    await expect(deletePhoto(photoId, recordId)).rejects.toThrow(/閲覧のみ/);

    const after = await recordById(recordId);
    expect(after.body).toBe(body); // 変わっていない
    expect(after.guest_visible).toBe(false);
  });
});

describe("作成系: 認可の基準は「シート/フォームを描画した世帯」（hidden household_id）", () => {
  it("editor はその世帯に作成できる（household_id がフォームの世帯になる）", async () => {
    await loginAs(PERSONAS.aEditor);
    const body = marker("editor-quick");
    await createQuickRecord(recordForm(seed.householdA, body));
    const rows = await findRecordByBody(body);
    expect(rows).toHaveLength(1);
    expect(rows[0].household_id).toBe(seed.householdA);
  });

  it("メンバーでない世帯の hidden を送りつけても作成できない", async () => {
    await loginAs(PERSONAS.aEditor); // B のメンバーではない
    const body = marker("cross-tenant");
    await expect(
      createQuickRecord(recordForm(seed.householdB, body)),
    ).rejects.toThrow(/この世帯のメンバーではありません/);
    expect(await findRecordByBody(body)).toHaveLength(0);
  });

  it("ゲスト grant はメンバーシップではない（期間内でも作成不可）", async () => {
    await loginAs(PERSONAS.guestActive);
    const body = marker("guest-active");
    await expect(
      createQuickRecord(recordForm(seed.householdA, body)),
    ).rejects.toThrow(/この世帯のメンバーではありません/);
    expect(await findRecordByBody(body)).toHaveLength(0);
  });

  it("両世帯に属するユーザー: Cookie の現在世帯が A でも、フォームの世帯 B に作成される", async () => {
    await loginAs(PERSONAS.abEditor);
    setHouseholdCookie(seed.householdA); // 別タブでは A を開いている状況
    const body = marker("ab-form-wins");
    await createQuickRecord(recordForm(seed.householdB, body));
    const rows = await findRecordByBody(body);
    expect(rows).toHaveLength(1);
    expect(rows[0].household_id).toBe(seed.householdB); // Cookie ではなくフォーム基準
  });

  it("createRecord も editor はフォームの世帯に作成でき、クライアント生成 id が行の id になる", async () => {
    await loginAs(PERSONAS.aEditor);
    const recordId = crypto.randomUUID();
    const body = marker("editor-full");
    await expectRedirectTo(
      createRecord(fullRecordForm(seed.householdA, recordId, body)),
      `/records/${recordId}`,
    );
    const row = await recordById(recordId);
    expect(row).not.toBeNull();
    expect(row.household_id).toBe(seed.householdA);
    expect(row.body).toBe(body);
  });

  it("createRecord: Cookie の現在世帯が A でも、フォームの世帯 B に作成される（兼任者）", async () => {
    await loginAs(PERSONAS.abEditor);
    setHouseholdCookie(seed.householdA);
    const recordId = crypto.randomUUID();
    const body = marker("ab-full-form-wins");
    await expectRedirectTo(
      createRecord(fullRecordForm(seed.householdB, recordId, body)),
      `/records/${recordId}`,
    );
    const row = await recordById(recordId);
    expect(row.household_id).toBe(seed.householdB);
  });

  it("createRecord: メンバーでない世帯の hidden は拒否され、行は作られない", async () => {
    await loginAs(PERSONAS.aEditor); // B のメンバーではない
    const recordId = crypto.randomUUID();
    await expect(
      createRecord(fullRecordForm(seed.householdB, recordId, marker("full-cross"))),
    ).rejects.toThrow(/この世帯のメンバーではありません/);
    expect(await recordById(recordId)).toBeNull();
  });

  it("createQuickRecord は本文が空なら保存しない", async () => {
    await loginAs(PERSONAS.aEditor);
    await expect(
      createQuickRecord(recordForm(seed.householdA, "   ")),
    ).rejects.toThrow(/本文が空/);
  });
});

describe("不変条件2: 更新/削除は「現在世帯」ではなく「対象行の household_id」で判定する", () => {
  it("正当な編集が弾かれない: A/B 兼任者が Cookie=B のまま A の記録を更新できる", async () => {
    const body = marker("ab-update-target");
    const recordId = await insertRecordInA(body);

    await loginAs(PERSONAS.abEditor);
    setHouseholdCookie(seed.householdB); // 現在世帯基準なら誤って B で検査してしまう状況

    const newBody = marker("ab-updated");
    await expectRedirectTo(
      updateRecord(recordId, recordForm(null, newBody)),
      `/records/${recordId}`,
    );

    const after = await recordById(recordId);
    expect(after.body).toBe(newBody);
    expect(after.household_id).toBe(seed.householdA); // 世帯は移動しない
  });

  it("誤った世帯で事前認可されない: 非メンバーには記録の存在ごと見えない", async () => {
    const body = marker("b-owner-attack");
    const recordId = await insertRecordInA(body);

    await loginAs(PERSONAS.bOwner);
    await expect(
      updateRecord(recordId, recordForm(null, "乗っ取り")),
    ).rejects.toThrow(/見つかりません/);
    await expect(deleteRecord(recordId)).rejects.toThrow(/見つかりません/);
    await expect(setRecordGuestVisible(recordId, true)).rejects.toThrow(
      /見つかりません/,
    );

    const after = await recordById(recordId);
    expect(after.body).toBe(body);
  });

  it("deleteRecord / setRecordGuestVisible / deletePhoto も対象行の世帯で判定される", async () => {
    const body = marker("ab-delete-target");
    const recordId = await insertRecordInA(body);
    const { rows: photoRows } = await db.query(
      `insert into public.record_photos (record_id, storage_path, household_id)
       values ($1, $2, $3) returning id`,
      [recordId, `${seed.householdA}/${recordId}/y.jpg`, seed.householdA],
    );
    const photoId = photoRows[0].id as string;

    await loginAs(PERSONAS.abEditor);
    setHouseholdCookie(seed.householdB);

    await setRecordGuestVisible(recordId, true);
    expect((await recordById(recordId)).guest_visible).toBe(true);

    await deletePhoto(photoId, recordId);
    const { rows: photosAfter } = await db.query(
      "select id from public.record_photos where id = $1",
      [photoId],
    );
    expect(photosAfter).toHaveLength(0);

    await expectRedirectTo(deleteRecord(recordId), "/");
    expect(await recordById(recordId)).toBeNull();
  });
});
