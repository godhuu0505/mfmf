import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";

// E2E 用ユーザーをローカル Supabase に用意する（再実行に対して冪等）。
//
// service_role はこのアプリでは使わない方針（CLAUDE.md）のため、
// 通常のセルフサインアップ（anon key）で作成する。ローカルは
// enable_confirmations=true（UC-O02 の意図的設定）なので、確認リンクの
// 代わりにローカル DB へ直接つないで email_confirmed_at を立てる。
// 127.0.0.1:54322/postgres はローカル開発スタックの既知の接続先で秘密ではない。

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const DB_URL =
  process.env.E2E_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

export const E2E_USER = {
  email: "e2e-editor@example.com",
  password: "e2e-quick-record-pass-1",
};

export default async function globalSetup() {
  // VRT のベースライン生成など、Supabase を使わないテストだけを回すための逃げ道。
  // CI では設定しないこと（quick-record の UC がログイン段階で落ちて検知される）。
  if (process.env.SKIP_E2E_SETUP === "1") return;
  if (!ANON_KEY) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_ANON_KEY が未設定です（`npx supabase start` 後にローカル値を export してから実行）",
    );
  }
  const supabase = createClient(SUPABASE_URL, ANON_KEY);

  // 既存ユーザーならそのままサインインできる
  let signIn = await supabase.auth.signInWithPassword(E2E_USER);
  if (signIn.error) {
    const { error: signUpError } = await supabase.auth.signUp(E2E_USER);
    if (signUpError) {
      throw new Error(`E2E ユーザーの作成に失敗: ${signUpError.message}`);
    }
    const db = new Client({ connectionString: DB_URL });
    await db.connect();
    try {
      await db.query(
        "update auth.users set email_confirmed_at = now() where email = $1 and email_confirmed_at is null",
        [E2E_USER.email],
      );
    } finally {
      await db.end();
    }
    signIn = await supabase.auth.signInWithPassword(E2E_USER);
    if (signIn.error) {
      throw new Error(`E2E ユーザーでサインインできません: ${signIn.error.message}`);
    }
  }

  // 世帯（owner として作成）。既に所属していれば create_own_household は
  // SECURITY DEFINER 側の「所属ゼロ」チェックで失敗するので、その場合は無視する。
  const { error: rpcError } = await supabase.rpc("create_own_household", {
    p_name: "E2E 世帯",
  });
  const { data: memberships, error: memberError } = await supabase
    .from("household_members")
    .select("household_id");
  if (memberError || !memberships || memberships.length === 0) {
    throw new Error(
      `E2E ユーザーの世帯を用意できません: ${rpcError?.message ?? memberError?.message ?? "unknown"}`,
    );
  }

  await supabase.auth.signOut();
}
