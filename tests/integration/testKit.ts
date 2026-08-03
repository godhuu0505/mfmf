// 各テストファイル共通の道具箱（クライアント切替・fixture・redirect 判定）。
// vi.mock の宣言だけは各テストファイルに書く必要がある（ファイル単位で hoist されるため）。

import { readFileSync } from "node:fs";
import { expect } from "vitest";
import {
  createClient as createSupabaseClient,
  type SupabaseClient,
} from "@supabase/supabase-js";
import { Client as PgClient } from "pg";
import { ANON_KEY, DB_URL, SEED_FILE, SUPABASE_URL, type Persona, type SeedIds } from "./env";
import { RedirectSentinel, setServerClient } from "./mockState";

export function loadSeed(): SeedIds {
  return JSON.parse(readFileSync(SEED_FILE, "utf8")) as SeedIds;
}

export function newDb(): PgClient {
  return new PgClient({ connectionString: DB_URL });
}

export function newAnonClient(): SupabaseClient {
  return createSupabaseClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const clients = new Map<string, SupabaseClient>();

// このペルソナとして Server Action を呼ぶ状態にする
export async function loginAs(persona: Persona): Promise<SupabaseClient> {
  let client = clients.get(persona.email);
  if (!client) {
    client = newAnonClient();
    const { error } = await client.auth.signInWithPassword(persona);
    if (error) throw new Error(`${persona.email}: ${error.message}`);
    clients.set(persona.email, client);
  }
  setServerClient(client);
  return client;
}

export function asAnonymous(): void {
  setServerClient(newAnonClient());
}

// 使い捨てユーザー（onboarding / 招待受諾の検証用）。実行ごとに一意なので後始末不要。
export async function createFreshUser(db: PgClient): Promise<Persona & { userId: string }> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const persona = {
    email: `int-fresh-${suffix}@example.com`,
    password: `int-pass-fresh-${suffix}`,
  };
  const supabase = newAnonClient();
  const { error: signUpError } = await supabase.auth.signUp(persona);
  if (signUpError) throw new Error(`fresh user 作成失敗: ${signUpError.message}`);
  await db.query(
    "update auth.users set email_confirmed_at = now() where email = $1 and email_confirmed_at is null",
    [persona.email],
  );
  const signIn = await supabase.auth.signInWithPassword(persona);
  if (signIn.error) throw new Error(`fresh user サインイン失敗: ${signIn.error.message}`);
  const userId = signIn.data.user?.id;
  if (!userId) throw new Error("fresh user の id が取れない");
  await supabase.auth.signOut();
  return { ...persona, userId };
}

export function marker(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

// 今日（実行時点）の YYYY-MM-DD。ゲスト grant の期間（今日基準で seed される）に
// 収まる日付が要るテストで使う —— 固定日付を書くとその日を過ぎた瞬間に壊れる。
export function todayISO(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

// instanceof はモジュールの二重解決で偽陰性になり得るため name で判定する
export function isRedirectTo(e: unknown, url: string): boolean {
  return (
    e instanceof Error &&
    e.name === "RedirectSentinel" &&
    (e as RedirectSentinel).url === url
  );
}

export async function expectLoginRedirect(p: Promise<unknown>): Promise<void> {
  await expect(p).rejects.toSatisfy((e: unknown) => isRedirectTo(e, "/login"));
}

// 成功時に redirect() で終わるアクション用（redirect も「成功の合図」）
export async function expectRedirectTo(
  p: Promise<unknown>,
  url: string,
): Promise<void> {
  await expect(p).rejects.toSatisfy((e: unknown) => isRedirectTo(e, url));
}
