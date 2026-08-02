import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client as PgClient } from "pg";
import { PERSONAS } from "./env";
import { setHouseholdCookie, fakeCookies } from "./mockState";
import {
  asAnonymous,
  expectLoginRedirect,
  expectRedirectTo,
  loadSeed,
  loginAs,
  marker,
  newDb,
  todayISO,
} from "./testKit";

// settings/actions.ts（12 アクション）の認可検証（Integration 層 / D30）。
// 世帯管理系の認可基準は「操作対象の世帯（画面を描画した世帯）での owner」で、
// Cookie の現在世帯には依存しない —— records と同じ D16 の不変条件を owner 版で見る。

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
  changePassword,
  createGuestInvite,
  createInvite,
  deleteHousehold,
  leaveHousehold,
  removeMember,
  renameHousehold,
  revokeGuestGrant,
  revokeInvite,
  switchHousehold,
  updateMemberRole,
  updateProfile,
} from "@/app/settings/actions";
import { createGuestRecord } from "@/app/guest/actions";

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

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

describe("未ログインの拒否", () => {
  it("redirect 型のアクションは /login へ", async () => {
    asAnonymous();
    await expectLoginRedirect(renameHousehold(seed.householdA, form({})));
    asAnonymous();
    await expectLoginRedirect(switchHousehold(seed.householdA));
    asAnonymous();
    await expectLoginRedirect(leaveHousehold(seed.householdA));
    asAnonymous();
    await expectLoginRedirect(updateProfile(null, form({})));
    asAnonymous();
    await expectLoginRedirect(changePassword(null, form({})));
  });
});

describe("owner 専用の世帯管理は「対象世帯での owner」以外を拒否する", () => {
  it("editor / viewer / 他世帯の owner はすべて拒否される", async () => {
    const attempts: [persona: (typeof PERSONAS)[keyof typeof PERSONAS]][] = [
      [PERSONAS.aEditor],
      [PERSONAS.aViewer],
      [PERSONAS.bOwner], // B の owner でも A に対しては非メンバー
    ];
    for (const [persona] of attempts) {
      await loginAs(persona);
      await expect(
        renameHousehold(seed.householdA, form({ household_name: "乗っ取り" })),
      ).rejects.toThrow(/owner のみ/);
      await expect(
        updateMemberRole(seed.householdA, seed.users.aViewer, form({ role: "editor" })),
      ).rejects.toThrow(/owner のみ/);
      await expect(
        createInvite(
          seed.householdA,
          form({ invite_email: "x@example.com", invite_role: "viewer" }),
        ),
      ).rejects.toThrow(/owner のみ/);
      await expect(removeMember(seed.householdA, seed.users.aViewer)).rejects.toThrow(
        /owner のみ/,
      );
      await expect(deleteHousehold(seed.householdA)).rejects.toThrow(/owner のみ/);
    }
    // 世帯名が変わっていない（seed の名前解決も守る）
    const { rows } = await db.query("select name from public.households where id = $1", [
      seed.householdA,
    ]);
    expect(rows[0].name).toBe("Int世帯A");
  });

  it("owner でも Cookie の現在世帯ではなく引数の世帯で判定される", async () => {
    // aOwner は A の owner。Cookie が B を指していても A への操作は通る
    await loginAs(PERSONAS.aOwner);
    setHouseholdCookie(seed.householdB);
    await updateMemberRole(seed.householdA, seed.users.aEditor, form({ role: "viewer" }));
    let { rows } = await db.query(
      "select role from public.household_members where household_id = $1 and user_id = $2",
      [seed.householdA, seed.users.aEditor],
    );
    expect(rows[0].role).toBe("viewer");
    // 元に戻す（他テストの前提。setup でも毎回貼り直されるが同一実行内のため即時復元）
    await updateMemberRole(seed.householdA, seed.users.aEditor, form({ role: "editor" }));
    ({ rows } = await db.query(
      "select role from public.household_members where household_id = $1 and user_id = $2",
      [seed.householdA, seed.users.aEditor],
    ));
    expect(rows[0].role).toBe("editor");
  });

  it("最後の owner の降格は DB トリガ（D6）のエラーがそのまま届く", async () => {
    await loginAs(PERSONAS.aOwner);
    await expect(
      updateMemberRole(seed.householdA, seed.users.aOwner, form({ role: "editor" })),
    ).rejects.toThrow(/ロールの変更に失敗しました/);
  });
});

describe("招待の発行・取消（owner のみ）", () => {
  it("createInvite → revokeInvite の往復と入力検証", async () => {
    await loginAs(PERSONAS.aOwner);
    await expect(
      createInvite(seed.householdA, form({ invite_email: "ダメ", invite_role: "viewer" })),
    ).rejects.toThrow(/メールアドレス/);
    await expect(
      createInvite(
        seed.householdA,
        form({ invite_email: "x@example.com", invite_role: "owner" }),
      ),
    ).rejects.toThrow(/不正なロール/);

    const email = `${marker("invite")}@example.com`.toLowerCase();
    await createInvite(seed.householdA, form({ invite_email: email, invite_role: "viewer" }));
    const { rows } = await db.query(
      "select id, revoked_at from public.household_invites where email = $1",
      [email],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].revoked_at).toBeNull();

    await revokeInvite(seed.householdA, rows[0].id);
    const { rows: after } = await db.query(
      "select revoked_at from public.household_invites where id = $1",
      [rows[0].id],
    );
    expect(after[0].revoked_at).not.toBeNull();
  });

  it("createGuestInvite は対象ペット・期間つきで発行される", async () => {
    await loginAs(PERSONAS.aOwner);
    const email = `${marker("guest-invite")}@example.com`.toLowerCase();
    await createGuestInvite(
      seed.householdA,
      form({
        guest_email: email,
        guest_role: "guest:daycare",
        guest_pet_id: seed.petA,
        guest_valid_from: "2026-08-01",
        guest_valid_to: "2026-08-31",
      }),
    );
    const { rows } = await db.query(
      "select scope_pet_id, valid_from::text, valid_to::text from public.household_invites where email = $1",
      [email],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].scope_pet_id).toBe(seed.petA);
    // 期間も送信どおり保存されていること（受諾時に guest_grants へ複写される値。
    // valid_to が落ちると無期限 grant になるため、ここの取りこぼしは実害になる）
    expect(rows[0].valid_from).toBe("2026-08-01");
    expect(rows[0].valid_to).toBe("2026-08-31");

    // 終了日 < 開始日は拒否
    await expect(
      createGuestInvite(
        seed.householdA,
        form({
          guest_email: "y@example.com",
          guest_role: "guest:daycare",
          guest_pet_id: seed.petA,
          guest_valid_from: "2026-08-31",
          guest_valid_to: "2026-08-01",
        }),
      ),
    ).rejects.toThrow(/終了日は開始日以降/);
  });
});

describe("ゲスト付与の失効（UC-G04）", () => {
  it("owner が失効するとゲストは即座に記入できなくなる（後始末で復元）", async () => {
    const { rows: grants } = await db.query(
      "select id from public.guest_grants where user_id = $1 and scope_pet_id = $2",
      [seed.users.guestActive, seed.petA],
    );
    const grantId = grants[0].id as string;

    await loginAs(PERSONAS.aOwner);
    await revokeGuestGrant(seed.householdA, grantId);
    const { rows: revoked } = await db.query(
      "select revoked_at from public.guest_grants where id = $1",
      [grantId],
    );
    expect(revoked[0].revoked_at).not.toBeNull();

    // 失効済みゲストの記入は RLS ごと弾かれる
    await loginAs(PERSONAS.guestActive);
    const fd = form({
      pet_id: seed.petA,
      record_date: todayISO(), // 固定日付は grant 期間（今日基準）を外れて壊れる
      source: "home",
      body: marker("revoked-guest"),
    });
    await expect(createGuestRecord(fd)).rejects.toThrow(/見つかりません|失敗/);

    // 復元（このファイル内の後続および他ファイルの guest テストの前提を壊さない）
    await db.query("update public.guest_grants set revoked_at = null where id = $1", [
      grantId,
    ]);
  });
});

describe("メンバー削除・退出", () => {
  it("removeMember は対象世帯の owner のみ（Cookie 非依存）", async () => {
    await loginAs(PERSONAS.aOwner);
    setHouseholdCookie(seed.householdB);
    await removeMember(seed.householdA, seed.users.aRemovable);
    const { rows } = await db.query(
      "select 1 from public.household_members where household_id = $1 and user_id = $2",
      [seed.householdA, seed.users.aRemovable],
    );
    expect(rows).toHaveLength(0);
  });

  it("leaveHousehold は自分のメンバーシップだけを消す", async () => {
    await loginAs(PERSONAS.aLeaver);
    await expectRedirectTo(leaveHousehold(seed.householdA), "/");
    const { rows } = await db.query(
      "select 1 from public.household_members where household_id = $1 and user_id = $2",
      [seed.householdA, seed.users.aLeaver],
    );
    expect(rows).toHaveLength(0);
  });

  it("最後の owner は退出できない（D6 トリガ）", async () => {
    await loginAs(PERSONAS.bOwner);
    await expect(leaveHousehold(seed.householdB)).rejects.toThrow(/退出に失敗/);
    const { rows } = await db.query(
      "select 1 from public.household_members where household_id = $1 and user_id = $2",
      [seed.householdB, seed.users.bOwner],
    );
    expect(rows).toHaveLength(1);
  });
});

describe("世帯の切替と削除", () => {
  it("switchHousehold はメンバーの世帯のみ受理し Cookie を書く", async () => {
    await loginAs(PERSONAS.abEditor);
    await expectRedirectTo(switchHousehold(seed.householdB), "/settings");
    expect(fakeCookies.get("mfmf-household")?.value).toBe(seed.householdB);

    // 非メンバーの世帯は拒否（Cookie も汚れない）
    setHouseholdCookie(null);
    await loginAs(PERSONAS.aEditor);
    await expect(switchHousehold(seed.householdB)).rejects.toThrow(
      /その世帯のメンバーではありません/,
    );
    expect(fakeCookies.get("mfmf-household")).toBeUndefined();
  });

  it("データのある世帯は削除できない（RPC のエラーが届く）", async () => {
    await loginAs(PERSONAS.aOwner);
    await expect(deleteHousehold(seed.householdA)).rejects.toThrow(
      /削除できませんでした/,
    );
    const { rows } = await db.query("select 1 from public.households where id = $1", [
      seed.householdA,
    ]);
    expect(rows).toHaveLength(1);
  });
});

describe("プロフィール・パスワード", () => {
  it("updateProfile は自分の profiles 行に upsert される", async () => {
    await loginAs(PERSONAS.aEditor);
    const name = marker("表示名");
    const result = await updateProfile(
      null,
      form({ display_name: name, default_author: "編集者" }),
    );
    expect(result.ok).toBe(true);
    const { rows } = await db.query(
      "select display_name, default_author from public.profiles where owner_id = $1",
      [seed.users.aEditor],
    );
    expect(rows[0].display_name).toBe(name);
    expect(rows[0].default_author).toBe("編集者");
  });

  it("changePassword は入力検証で弾く（8 文字未満・不一致）", async () => {
    // 成功系は意図的にテストしない: seed の資格情報が回転すると再実行が壊れる
    await loginAs(PERSONAS.aEditor);
    const short = await changePassword(
      null,
      form({ password: "short", password_confirm: "short" }),
    );
    expect(short.ok).toBe(false);
    expect(short.message).toMatch(/8 文字以上/);

    const mismatch = await changePassword(
      null,
      form({ password: "long-enough-pass", password_confirm: "different-pass" }),
    );
    expect(mismatch.ok).toBe(false);
    expect(mismatch.message).toMatch(/一致しません/);
  });
});
