// Server Action を Vitest から呼ぶための「継ぎ目」の状態。
//
// モックするのは Next.js のインフラ 3 点だけ（cookies / redirect / revalidatePath）
// と、@/lib/supabase/server の createClient（→ ここで差し込む実クライアント）。
// 認可ロジック・RLS・PostgREST は全部本物が動く。

import type { SupabaseClient } from "@supabase/supabase-js";

let current: SupabaseClient | null = null;

export function setServerClient(client: SupabaseClient) {
  current = client;
}

export function getServerClient(): SupabaseClient {
  if (!current) {
    throw new Error("setServerClient() を先に呼ぶこと（テストのセットアップ漏れ）");
  }
  return current;
}

// HOUSEHOLD_COOKIE（「現在の世帯」）の偽装用クッキーストア。
// household.ts が next/headers の cookies() 経由で読む形と互換にする。
const jar = new Map<string, string>();

export const fakeCookies = {
  get(name: string) {
    const value = jar.get(name);
    return value === undefined ? undefined : { name, value };
  },
  getAll() {
    return [...jar.entries()].map(([name, value]) => ({ name, value }));
  },
  set(name: string, value: string) {
    jar.set(name, value);
  },
  delete(name: string) {
    jar.delete(name);
  },
};

// 「別タブで世帯を切り替えている」状況の再現に使う。
export function setHouseholdCookie(householdId: string | null) {
  if (householdId === null) jar.delete("mfmf-household");
  else jar.set("mfmf-household", householdId);
}

// next/navigation の redirect() は例外で処理を中断する。同じ形を再現し、
// テストからは「どこへ」を検証できるようにする。
export class RedirectSentinel extends Error {
  constructor(public readonly url: string) {
    super(`redirect: ${url}`);
    this.name = "RedirectSentinel";
  }
}
