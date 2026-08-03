import { test, expect } from "@playwright/test";

// 利用規約・プライバシーポリシー（下書きページ）の受け入れ条件（D25）。
// - 未ログインで直接アクセスでき、/login へリダイレクトされないこと
//   （middleware の isPublicRoute に /terms・/privacy が入っている前提が崩れると落ちる）
// - 見出しと「これは下書きです」バナーが表示されること
// SignupForm のリンク検証はここではやらない（SIGNUP_ENABLED を E2E 環境で
// 有効にすると /login に新規登録リンクが増えて VRT ベースラインが壊れる）。

test("利用規約: 未ログインで閲覧でき、下書きバナーが出る", async ({ page }) => {
  await page.goto("/terms");
  await expect(page).toHaveURL(/\/terms$/);
  await expect(page.getByRole("heading", { name: "利用規約" })).toBeVisible();
  await expect(page.getByText("これは下書きです")).toBeVisible();
});

test("プライバシーポリシー: 未ログインで閲覧でき、下書きバナーが出る", async ({
  page,
}) => {
  await page.goto("/privacy");
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(
    page.getByRole("heading", { name: "プライバシーポリシー" }),
  ).toBeVisible();
  await expect(page.getByText("これは下書きです")).toBeVisible();
});
