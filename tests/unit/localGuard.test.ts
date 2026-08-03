import { describe, expect, it } from "vitest";
import { assertLocalSupabase } from "../localGuard";

// テスト seed の宛先ガード（V3）。本番 Supabase へ実ユーザー作成・メール送信が
// 飛ぶ事故を globalSetup の入口で塞ぐ。壊れて素通しになったらここで落ちる。

const LOCAL_DB = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

describe("assertLocalSupabase", () => {
  it("ローカル（127.0.0.1 / localhost）の組み合わせは通る", () => {
    expect(() =>
      assertLocalSupabase("http://127.0.0.1:54321", LOCAL_DB),
    ).not.toThrow();
    expect(() =>
      assertLocalSupabase(
        "http://localhost:54321",
        "postgresql://postgres:postgres@localhost:54322/postgres",
      ),
    ).not.toThrow();
  });

  it("ホスト済み Supabase の URL は拒否する", () => {
    expect(() =>
      assertLocalSupabase("https://abcdefg.supabase.co", LOCAL_DB),
    ).toThrow(/ローカル.*以外/);
  });

  it("ホスト済み DB の接続文字列は拒否する", () => {
    expect(() =>
      assertLocalSupabase(
        "http://127.0.0.1:54321",
        "postgresql://postgres:secret@db.abcdefg.supabase.co:5432/postgres",
      ),
    ).toThrow(/ローカル.*以外/);
  });

  it("URL として解釈できない値は拒否する", () => {
    expect(() => assertLocalSupabase("not a url", LOCAL_DB)).toThrow(
      /解釈できません/,
    );
  });
});
