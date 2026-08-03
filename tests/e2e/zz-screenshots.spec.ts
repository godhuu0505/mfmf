import { test, type Page } from "@playwright/test";
import { login } from "./helpers";

// UI 変更 PR 用のスクリーンショット生成（CLAUDE.md「Git / PR」参照）。
// アサーションは持たない。他 spec の後（zz- 接頭辞で最後）に走らせ、
// 記録が入った状態の画面を test-results/screenshots/ へ保存する。
// CI の playwright-report アーティファクトに含まれるので、そこから取得して
// PR にキャプチャとして貼る。

const DIR = "test-results/screenshots";

async function shot(page: Page, name: string, fullPage = true) {
  await page.waitForTimeout(300); // 遷移直後のスケルトン・トランジションを避ける
  await page.screenshot({ path: `${DIR}/${name}.png`, fullPage });
}

test("スクリーンショット一式（ライト）", async ({ page }) => {
  test.setTimeout(120_000); // 12 画面ぶんの遷移とキャプチャ
  await page.goto("/login");
  await shot(page, "login");

  await login(page);
  await shot(page, "home");

  await page.goto("/calendar");
  await shot(page, "calendar");
  // 記録のある日のシート
  const dayWithRecords = page.getByRole("button", { name: /記録\d+件/ });
  if ((await dayWithRecords.count()) > 0) {
    await dayWithRecords.last().click();
    await shot(page, "calendar-day-sheet", false);
    await page.keyboard.press("Escape");
  }

  // クイック記録シート（タブバー中央）
  await page.getByRole("button", { name: "クイック記録" }).click();
  await shot(page, "quick-record-sheet", false);
  await page.keyboard.press("Escape");

  await page.goto("/menu");
  await shot(page, "menu");

  await page.goto("/weight");
  await shot(page, "weight");

  await page.goto("/pets");
  await shot(page, "pets");

  await page.goto("/settings");
  await shot(page, "settings");

  await page.goto("/records/new");
  await shot(page, "record-new");

  await page.goto("/");
  await page.locator("main ul > li").first().click();
  await page.waitForURL(/\/records\/[0-9a-f-]{36}/);
  await shot(page, "record-detail");
});

test.describe("ダーク", () => {
  test.use({ colorScheme: "dark" });

  test("スクリーンショット一式（ダーク）", async ({ page }) => {
    await login(page);
    await shot(page, "home-dark");
    await page.goto("/menu");
    await shot(page, "menu-dark");
  });
});
