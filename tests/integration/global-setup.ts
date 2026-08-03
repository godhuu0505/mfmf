import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { Client as PgClient } from "pg";
import { assertLocalSupabase } from "../localGuard";
import {
  ANON_KEY,
  DB_URL,
  HOUSEHOLD_A_NAME,
  HOUSEHOLD_B_NAME,
  PERSONAS,
  SEED_FILE,
  type Persona,
  type SeedIds,
} from "./env";

// Integration テスト用の世帯・ユーザー・ゲスト grant を用意する（再実行に対して冪等）。
//
// ユーザー作成はアプリと同じ経路（anon key のセルフサインアップ +
// create_own_household RPC）を使う。管理者キーはこのアプリでは使わない方針のため、
// メール確認だけローカル DB を直接更新して確定させる。
// メンバーシップ（editor / viewer / 兼任）とゲスト grant は fixture として
// DB へ直接投入する（アプリに管理 UI 経由でしか作れない前提を課さないため）。

function newAnonClient() {
  return createClient(SUPABASE_URL_, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const SUPABASE_URL_ =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";

async function ensureUser(db: PgClient, persona: Persona): Promise<string> {
  const supabase = newAnonClient();
  let signIn = await supabase.auth.signInWithPassword(persona);
  if (signIn.error) {
    const { error: signUpError } = await supabase.auth.signUp(persona);
    if (signUpError) {
      throw new Error(`${persona.email} の作成に失敗: ${signUpError.message}`);
    }
    await db.query(
      "update auth.users set email_confirmed_at = now() where email = $1 and email_confirmed_at is null",
      [persona.email],
    );
    signIn = await supabase.auth.signInWithPassword(persona);
    if (signIn.error) {
      throw new Error(`${persona.email} でサインイン不可: ${signIn.error.message}`);
    }
  }
  const userId = signIn.data.user?.id;
  if (!userId) throw new Error(`${persona.email} の user id が取れない`);
  await supabase.auth.signOut();
  return userId;
}

// owner がまだ世帯を持っていなければ create_own_household（実 RPC）で作る。
async function ensureHousehold(
  db: PgClient,
  owner: Persona,
  ownerId: string,
  name: string,
): Promise<string> {
  const existing = await db.query(
    `select h.id from public.households h
       join public.household_members m on m.household_id = h.id
      where h.name = $1 and m.user_id = $2 and m.role = 'owner'`,
    [name, ownerId],
  );
  if (existing.rows.length > 0) return existing.rows[0].id as string;

  const supabase = newAnonClient();
  const { error: signInError } = await supabase.auth.signInWithPassword(owner);
  if (signInError) throw new Error(`${owner.email}: ${signInError.message}`);
  const { error: rpcError } = await supabase.rpc("create_own_household", {
    p_name: name,
  });
  await supabase.auth.signOut();
  if (rpcError) {
    throw new Error(`${name} の作成に失敗: ${rpcError.message}`);
  }

  const created = await db.query(
    `select h.id from public.households h
       join public.household_members m on m.household_id = h.id
      where h.name = $1 and m.user_id = $2 and m.role = 'owner'`,
    [name, ownerId],
  );
  if (created.rows.length === 0) throw new Error(`${name} が見つからない`);
  return created.rows[0].id as string;
}

async function ensureMembership(
  db: PgClient,
  householdId: string,
  userId: string,
  role: "owner" | "editor" | "viewer",
) {
  await db.query(
    `insert into public.household_members (household_id, user_id, role)
     values ($1, $2, $3)
     on conflict (household_id, user_id) do update set role = excluded.role`,
    [householdId, userId, role],
  );
}

async function ensurePet(
  db: PgClient,
  ownerId: string,
  householdId: string,
  name: string,
): Promise<string> {
  const existing = await db.query(
    "select id from public.pets where household_id = $1 and name = $2",
    [householdId, name],
  );
  if (existing.rows.length > 0) return existing.rows[0].id as string;
  const inserted = await db.query(
    `insert into public.pets (owner_id, household_id, name)
     values ($1, $2, $3) returning id`,
    [ownerId, householdId, name],
  );
  return inserted.rows[0].id as string;
}

async function ensureGuestGrant(
  db: PgClient,
  householdId: string,
  guestUserId: string,
  petId: string,
  createdBy: string,
  period: "active" | "expired",
) {
  // active: 昨日〜7日後 / expired: 30日前〜昨日
  const range =
    period === "active"
      ? "current_date - 1, current_date + 7"
      : "current_date - 30, current_date - 1";
  const existing = await db.query(
    "select id from public.guest_grants where user_id = $1 and scope_pet_id = $2",
    [guestUserId, petId],
  );
  if (existing.rows.length > 0) {
    // スタックを使い回しても期間条件が腐らないよう、毎回「今日」基準で貼り直す
    // （7 日より古い grant を残すと guestActive が実は期間切れ、という嘘の緑になる）
    const [from, to] = range.split(", ");
    await db.query(
      `update public.guest_grants
          set valid_from = ${from}, valid_to = ${to}, revoked_at = null
        where id = $1`,
      [existing.rows[0].id],
    );
    return;
  }
  await db.query(
    `insert into public.guest_grants
       (household_id, user_id, scope_pet_id, role, valid_from, valid_to, created_by)
     values ($1, $2, $3, 'guest:daycare', ${range}, $4)`,
    [householdId, guestUserId, petId, createdBy],
  );
}

export default async function globalSetup() {
  if (!ANON_KEY) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_ANON_KEY が未設定です（`npx supabase start` 後にローカル値を export してから実行）",
    );
  }
  // .env.local が本番を指したまま実行しても、本物へは 1 リクエストも送らせない
  assertLocalSupabase(SUPABASE_URL_, DB_URL);

  const db = new PgClient({ connectionString: DB_URL });
  await db.connect();
  try {
    const users = {} as SeedIds["users"];
    for (const key of Object.keys(PERSONAS) as (keyof typeof PERSONAS)[]) {
      users[key] = await ensureUser(db, PERSONAS[key]);
    }

    const householdA = await ensureHousehold(
      db,
      PERSONAS.aOwner,
      users.aOwner,
      HOUSEHOLD_A_NAME,
    );
    const householdB = await ensureHousehold(
      db,
      PERSONAS.bOwner,
      users.bOwner,
      HOUSEHOLD_B_NAME,
    );

    await ensureMembership(db, householdA, users.aEditor, "editor");
    await ensureMembership(db, householdA, users.aViewer, "viewer");
    // 兼任ユーザー: A と B の両方で editor（「対象行の世帯」不変条件の検証用）
    await ensureMembership(db, householdA, users.abEditor, "editor");
    await ensureMembership(db, householdB, users.abEditor, "editor");
    // removeMember / leaveHousehold の対象。テストが削除しても毎回貼り直される
    await ensureMembership(db, householdA, users.aRemovable, "viewer");
    await ensureMembership(db, householdA, users.aLeaver, "viewer");

    const petA = await ensurePet(db, users.aOwner, householdA, "Intポチ");
    const petB = await ensurePet(db, users.bOwner, householdB, "Intタマ");
    await ensureGuestGrant(db, householdA, users.guestActive, petA, users.aOwner, "active");
    await ensureGuestGrant(db, householdA, users.guestExpired, petA, users.aOwner, "expired");

    const seed: SeedIds = { householdA, householdB, petA, petB, users };
    writeFileSync(SEED_FILE, JSON.stringify(seed, null, 2));
  } finally {
    await db.end();
  }
}
