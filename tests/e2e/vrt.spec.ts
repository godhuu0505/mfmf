import { test, expect, type Page } from "@playwright/test";

// ビジュアルリグレッション（D31）。
// ベースラインは Linux（CI と同一の chromium ビルド + Noto CJK フォント）で
// `npx playwright test tests/e2e/vrt.spec.ts --update-snapshots` により生成してコミットする。
// 対象は認証不要で内容が静的な画面（ライト/ダーク両テーマ）。認証後の画面は
// 動的要素（日付・記録）が多く、D26 のスクリーンショット生成 CI と併せて設計する。
// 動的要素が入る画面を足すときは mask すること。

async function shootLogin(page: Page, name: string) {
  await page.goto("/login");
  await expect(
    page.getByRole("button", { name: "メールアドレスでログイン" }),
  ).toBeVisible();
  await expect(page).toHaveScreenshot(name, { fullPage: true });
}

async function shootForgotPassword(page: Page, name: string) {
  await page.goto("/forgot-password");
  await expect(
    page.getByRole("heading", { name: "パスワードの再設定" }),
  ).toBeVisible();
  await expect(page).toHaveScreenshot(name, { fullPage: true });
}

async function shootTerms(page: Page, name: string) {
  await page.goto("/terms");
  await expect(page.getByRole("heading", { name: "利用規約" })).toBeVisible();
  await expect(page).toHaveScreenshot(name, { fullPage: true });
}

async function shootPrivacy(page: Page, name: string) {
  await page.goto("/privacy");
  await expect(
    page.getByRole("heading", { name: "プライバシーポリシー" }),
  ).toBeVisible();
  await expect(page).toHaveScreenshot(name, { fullPage: true });
}

test("VRT: ログイン画面", async ({ page }) => {
  await shootLogin(page, "login.png");
});

test("VRT: パスワード再設定の入口", async ({ page }) => {
  await shootForgotPassword(page, "forgot-password.png");
});

test("VRT: 利用規約（下書き）", async ({ page }) => {
  await shootTerms(page, "terms.png");
});

test("VRT: プライバシーポリシー（下書き）", async ({ page }) => {
  await shootPrivacy(page, "privacy.png");
});

test.describe("ダークモード", () => {
  test.use({ colorScheme: "dark" });

  test("VRT: ログイン画面（ダーク）", async ({ page }) => {
    await shootLogin(page, "login-dark.png");
  });

  test("VRT: パスワード再設定の入口（ダーク）", async ({ page }) => {
    await shootForgotPassword(page, "forgot-password-dark.png");
  });

  test("VRT: 利用規約（下書き・ダーク）", async ({ page }) => {
    await shootTerms(page, "terms-dark.png");
  });

  test("VRT: プライバシーポリシー（下書き・ダーク）", async ({ page }) => {
    await shootPrivacy(page, "privacy-dark.png");
  });
});
