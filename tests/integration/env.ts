// Integration テストの接続先とペルソナ定義。
// 127.0.0.1:54321/54322 と postgres/postgres はローカル開発スタックの既知の値で
// 秘密ではない（本番の値はここには存在しない）。

export const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
export const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
export const DB_URL =
  process.env.E2E_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

// seed が用意するペルソナ（PR-C の計画どおり）:
// - 世帯 A: owner / editor / viewer の 3 人
// - 世帯 B: 別テナント（owner）
// - 世帯 A と B の両方に属するユーザー（「対象行の世帯」不変条件の検証に必須）
// - 期間内 / 期間外のゲスト grant を持つ外部ユーザー
export const PERSONAS = {
  aOwner: { email: "int-a-owner@example.com", password: "int-pass-a-owner-1" },
  aEditor: { email: "int-a-editor@example.com", password: "int-pass-a-editor-1" },
  aViewer: { email: "int-a-viewer@example.com", password: "int-pass-a-viewer-1" },
  bOwner: { email: "int-b-owner@example.com", password: "int-pass-b-owner-1" },
  abEditor: {
    email: "int-ab-editor@example.com",
    password: "int-pass-ab-editor-1",
  },
  guestActive: {
    email: "int-guest-active@example.com",
    password: "int-pass-guest-act-1",
  },
  guestExpired: {
    email: "int-guest-expired@example.com",
    password: "int-pass-guest-exp-1",
  },
} as const;

export type Persona = (typeof PERSONAS)[keyof typeof PERSONAS];

export const HOUSEHOLD_A_NAME = "Int世帯A";
export const HOUSEHOLD_B_NAME = "Int世帯B";

// globalSetup が書き出し、テストが読む seed の実 ID。
export const SEED_FILE = new URL("./.seed.json", import.meta.url).pathname;

export type SeedIds = {
  householdA: string;
  householdB: string;
  petA: string;
  users: Record<keyof typeof PERSONAS, string>;
};
