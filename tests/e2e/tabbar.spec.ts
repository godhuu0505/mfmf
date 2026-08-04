import { test, expect, type Page } from "@playwright/test";
import { login } from "./helpers";

// ボトムタブバーとメニュー画面（proto/app-redesign/spec.md UC-N01 / UC-N02 / UC-M01 / UC-M02）。
// D33: 主要ナビは 5 スロットのタブバー（中央にクイック記録）。
// UC-N03（viewer は中央ボタンなし）は viewer ユーザーのフィクスチャ整備後に追加する。

function tabbar(page: Page) {
  return page.getByRole("navigation", { name: "メインナビゲーション" });
}

test("UC-N01: タブバーで主要画面へ 1 タップ移動でき、アクティブタブが分かる", async ({
  page,
}) => {
  await login(page);
  await expect(tabbar(page)).toBeVisible();

  // ホームではホームタブがアクティブ
  await expect(tabbar(page).getByRole("link", { name: "ホーム" })).toHaveAttribute(
    "aria-current",
    "page",
  );

  await tabbar(page).getByRole("link", { name: "カレンダー" }).click();
  await page.waitForURL("**/calendar**");
  await expect(
    tabbar(page).getByRole("link", { name: "カレンダー" }),
  ).toHaveAttribute("aria-current", "page");

  await tabbar(page).getByRole("link", { name: "アルバム" }).click();
  await page.waitForURL("**/gallery**");
  await expect(
    tabbar(page).getByRole("link", { name: "アルバム" }),
  ).toHaveAttribute("aria-current", "page");
});

test("UC-N02: ホーム以外の画面でも中央ボタンからクイック記録できる", async ({
  page,
}) => {
  await login(page);
  await tabbar(page).getByRole("link", { name: "カレンダー" }).click();
  await page.waitForURL("**/calendar**");

  await tabbar(page).getByRole("button", { name: "クイック記録" }).click();
  const sheet = page.getByRole("dialog", { name: "クイック記録" });
  await expect(sheet).toBeVisible();

  await sheet.getByRole("button", { name: "ごきげん" }).click();
  await sheet.getByRole("button", { name: "保存する" }).click();
  await expect(sheet).not.toBeVisible();

  // 保存後はホームの先頭に出る（UC-Q06 と同じ契約）
  await page.waitForURL((url) => url.pathname === "/");
  await expect(page.locator("main ul > li").first()).toContainText("ごきげん");
});

test("UC-M01: メニューから体重・世帯設定へ 2 タップ以内で届く", async ({
  page,
}) => {
  await login(page);
  await tabbar(page).getByRole("link", { name: "メニュー" }).click();
  await page.waitForURL("**/menu**");

  // 主要な行が揃っている
  for (const label of ["ペット", "体重の推移", "世帯の設定", "使い方ガイド"]) {
    await expect(page.getByRole("link", { name: label })).toBeVisible();
  }
  await expect(
    page.getByRole("button", { name: "ご意見・不具合を送る" }),
  ).toBeVisible();

  await page.getByRole("link", { name: "体重の推移" }).click();
  await page.waitForURL("**/weight**");
  await expect(
    page.getByRole("heading", { name: "体重の推移" }),
  ).toBeVisible();
});

test("UC-M02: メニューのログアウトは確認ダイアログを挟む", async ({ page }) => {
  await login(page);
  await tabbar(page).getByRole("link", { name: "メニュー" }).click();
  await page.waitForURL("**/menu**");

  await page.getByRole("button", { name: "ログアウト" }).click();
  const dialog = page.getByRole("dialog", { name: "ログアウトしますか？" });
  await expect(dialog).toBeVisible();

  // いいえ → メニューに留まる
  await dialog.getByRole("button", { name: "いいえ" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page).toHaveURL(/\/menu/);

  // はい → ログイン画面へ
  await page.getByRole("button", { name: "ログアウト" }).click();
  await dialog.getByRole("button", { name: "はい" }).click();
  await page.waitForURL("**/login**");
});
