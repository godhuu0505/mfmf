import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client as PgClient } from "pg";
import { PERSONAS } from "./env";
import { fakeCookies, setHouseholdCookie } from "./mockState";
import {
  asAnonymous,
  createFreshUser,
  expectLoginRedirect,
  expectRedirectTo,
  loadSeed,
  loginAs,
  marker,
  newDb,
} from "./testKit";

// onboarding(1) / invite(1) / guest(1) / feedback(3) の認可検証。
// /onboarding は「世帯未所属で走るのが正常」なので世帯チェックのテストは書かない
// （create_own_household が SECURITY DEFINER 側で所属ゼロを強制する。
//  ここに世帯チェックを課すテストを書くと正しい実装を落とす）。

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

import { createOwnHousehold } from "@/app/onboarding/actions";
import { acceptInvite } from "@/app/invite/actions";
import { createGuestRecord } from "@/app/guest/actions";
import {
  deleteFeedback,
  setFeedbackStatus,
  submitFeedback,
} from "@/app/feedback/actions";
import { createInvite, deleteHousehold, renameHousehold } from "@/app/settings/actions";

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

describe("onboarding: createOwnHousehold（世帯未所属で走るのが正常）", () => {
  it("未所属の新規ユーザーは世帯を作れて、Cookie が新世帯を指し、/pets へ進む", async () => {
    const fresh = await createFreshUser(db);
    await loginAs(fresh);

    await expectRedirectTo(createOwnHousehold(form({ name: "フレッシュ世帯" })), "/pets");

    const { rows } = await db.query(
      `select h.id from public.households h
         join public.household_members m on m.household_id = h.id
        where m.user_id = $1 and m.role = 'owner'`,
      [fresh.userId],
    );
    expect(rows).toHaveLength(1);
    const newHouseholdId = rows[0].id as string;
    expect(fakeCookies.get("mfmf-household")?.value).toBe(newHouseholdId);

    // 作りたての世帯は owner として名前を変えられる（UC-H02 の正常系）
    const renamed = marker("改名世帯");
    await renameHousehold(newHouseholdId, form({ household_name: renamed }));
    const { rows: renamedRows } = await db.query(
      "select name from public.households where id = $1",
      [newHouseholdId],
    );
    expect(renamedRows[0].name).toBe(renamed);

    // 空の世帯なので owner は削除できる（UC-H09）。Cookie も畳まれる
    await expectRedirectTo(deleteHousehold(newHouseholdId), "/");
    expect(fakeCookies.get("mfmf-household")).toBeUndefined();
    const { rows: gone } = await db.query(
      "select 1 from public.households where id = $1",
      [newHouseholdId],
    );
    expect(gone).toHaveLength(0);
  });

  it("既に所属しているユーザーは RPC 側（所属ゼロ強制）で拒否される", async () => {
    await loginAs(PERSONAS.aEditor);
    await expect(
      createOwnHousehold(form({ name: "二個目" })),
    ).rejects.toThrow(/世帯の作成に失敗/);
  });

  it("未ログインは /login へ", async () => {
    asAnonymous();
    await expectLoginRedirect(createOwnHousehold(form({ name: "x" })));
  });
});

describe("invite: acceptInvite（検証は accept_household_invite RPC / D12）", () => {
  it("宛先本人が受諾するとその世帯のメンバーになる", async () => {
    const fresh = await createFreshUser(db);

    // owner が fresh 宛の viewer 招待を発行
    await loginAs(PERSONAS.aOwner);
    await createInvite(
      seed.householdA,
      form({ invite_email: fresh.email, invite_role: "viewer" }),
    );
    const { rows: invites } = await db.query(
      "select token from public.household_invites where email = $1",
      [fresh.email],
    );
    const token = invites[0].token as string;

    // 宛先本人の受諾は通る
    await loginAs(fresh);
    await expectRedirectTo(acceptInvite(token), "/");
    const { rows: membership } = await db.query(
      "select role from public.household_members where household_id = $1 and user_id = $2",
      [seed.householdA, fresh.userId],
    );
    expect(membership).toHaveLength(1);
    expect(membership[0].role).toBe("viewer");
  });

  it("宛先でないユーザーの受諾は拒否される（D12 宛先メール固定）", async () => {
    const fresh = await createFreshUser(db);
    await loginAs(PERSONAS.aOwner);
    await createInvite(
      seed.householdA,
      form({ invite_email: fresh.email, invite_role: "viewer" }),
    );
    const { rows: invites } = await db.query(
      "select token from public.household_invites where email = $1",
      [fresh.email],
    );

    await loginAs(PERSONAS.bOwner); // 宛先ではない
    await expect(acceptInvite(invites[0].token)).rejects.toThrow(
      /受諾できませんでした/,
    );
    const { rows } = await db.query(
      "select 1 from public.household_members where household_id = $1 and user_id = $2",
      [seed.householdA, seed.users.bOwner],
    );
    expect(rows).toHaveLength(0);
  });
});

describe("guest: createGuestRecord（不変条件4: 対象ペット・期間の範囲のみ）", () => {
  function guestForm(petId: string, body: string): FormData {
    return form({
      pet_id: petId,
      record_date: "2026-08-02",
      source: "home",
      author: "ゲスト",
      body,
    });
  }

  it("期間内のゲストは担当ペットに記入でき、世帯に guest_visible=false で残る", async () => {
    await loginAs(PERSONAS.guestActive);
    const body = marker("guest-ok");
    await expectRedirectTo(createGuestRecord(guestForm(seed.petA, body)), "/guest");

    const { rows } = await db.query(
      "select household_id, owner_id, guest_visible from public.daycare_records where body = $1",
      [body],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].household_id).toBe(seed.householdA);
    expect(rows[0].owner_id).toBe(seed.users.guestActive);
    expect(rows[0].guest_visible).toBe(false);
  });

  it("期間外のゲストには担当ペットすら見えず、記入できない", async () => {
    await loginAs(PERSONAS.guestExpired);
    const body = marker("guest-expired");
    await expect(createGuestRecord(guestForm(seed.petA, body))).rejects.toThrow(
      /見つかりません/,
    );
    const { rows } = await db.query(
      "select 1 from public.daycare_records where body = $1",
      [body],
    );
    expect(rows).toHaveLength(0);
  });

  it("担当外のペット（他世帯）には記入できない", async () => {
    await loginAs(PERSONAS.guestActive);
    const body = marker("guest-cross-pet");
    await expect(createGuestRecord(guestForm(seed.petB, body))).rejects.toThrow(
      /見つかりません/,
    );
    const { rows } = await db.query(
      "select 1 from public.daycare_records where body = $1",
      [body],
    );
    expect(rows).toHaveLength(0);
  });

  it("未ログインは /login へ", async () => {
    asAnonymous();
    await expectLoginRedirect(createGuestRecord(guestForm(seed.petA, "x")));
  });
});

describe("feedback: 本人の行のみ操作できる", () => {
  it("submitFeedback は未ログインでも redirect せず ok:false を返す（フォーム内で案内）", async () => {
    asAnonymous();
    const result = await submitFeedback({ ok: false }, form({ body: "x" }));
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/ログイン/);
  });

  it("送信すると自分の行として household_id つきで残り、他人は状態変更も削除もできない", async () => {
    await loginAs(PERSONAS.aEditor);
    const body = marker("feedback");
    const result = await submitFeedback({ ok: false }, form({ body, kind: "bug" }));
    expect(result.ok).toBe(true);

    const { rows } = await db.query(
      "select id, household_id, status from public.feedback where body = $1",
      [body],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].household_id).toBe(seed.householdA);
    const feedbackId = rows[0].id as string;
    const originalStatus = rows[0].status as string;

    // 他人（bOwner）による状態変更・削除は owner_id 条件で空振りする（エラーにはならない）
    await loginAs(PERSONAS.bOwner);
    await setFeedbackStatus(feedbackId, form({ status: "triaged" }));
    await deleteFeedback(feedbackId);
    const { rows: untouched } = await db.query(
      "select status from public.feedback where id = $1",
      [feedbackId],
    );
    expect(untouched).toHaveLength(1); // 消えていない
    expect(untouched[0].status).toBe(originalStatus); // 変わっていない

    // 本人は状態変更も削除もできる
    await loginAs(PERSONAS.aEditor);
    await setFeedbackStatus(feedbackId, form({ status: "triaged" }));
    const { rows: updated } = await db.query(
      "select status from public.feedback where id = $1",
      [feedbackId],
    );
    expect(updated[0].status).toBe("triaged");

    await deleteFeedback(feedbackId);
    const { rows: gone } = await db.query(
      "select 1 from public.feedback where id = $1",
      [feedbackId],
    );
    expect(gone).toHaveLength(0);
  });

  it("空の本文は受け付けない", async () => {
    await loginAs(PERSONAS.aEditor);
    const result = await submitFeedback({ ok: false }, form({ body: "  " }));
    expect(result.ok).toBe(false);
  });
});
