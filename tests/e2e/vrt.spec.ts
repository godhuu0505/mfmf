import { test, expect } from "@playwright/test";

// ビジュアルリグレッション（D31 の最小 1 枚）。
// ベースラインは Linux（CI と同一の chromium ビルド + Noto CJK フォント）で
// `npx playwright test tests/e2e/vrt.spec.ts --update-snapshots` により生成してコミットする。
// 対象は認証不要で内容が静的な /login。動的要素が入る画面を足すときは mask すること。
test("VRT: ログイン画面", async ({ page }) => {
  await page.goto("/login");
  await expect(
    page.getByRole("button", { name: "メールアドレスでログイン" }),
  ).toBeVisible();
  await expect(page).toHaveScreenshot("login.png", { fullPage: true });
});
