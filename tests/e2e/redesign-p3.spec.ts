import { test, expect } from "@playwright/test";
import { login, quickRecord } from "./helpers";

// P3（proto/app-redesign/spec.md UC-F01 / UC-C01 / UC-D01）。
// フォームの確認ダイアログ・カレンダーの日別シート・記録詳細の「…」削除。

test("UC-F01: 記録フォームのキャンセルは確認してから破棄する", async ({
  page,
}) => {
  await login(page);
  await page.goto("/records/new");
  await page
    .getByPlaceholder("今日の様子などを記録します")
    .fill("破棄される下書き");

  await page.getByRole("button", { name: "キャンセル" }).click();
  const dialog = page.getByRole("dialog", { name: "編集をやめますか？" });
  await expect(dialog).toBeVisible();

  // もどる → フォームに残る
  await dialog.getByRole("button", { name: "もどる" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByPlaceholder("今日の様子などを記録します"),
  ).toHaveValue("破棄される下書き");

  // 破棄してもどる → 一覧へ
  await page.getByRole("button", { name: "キャンセル" }).click();
  await dialog.getByRole("button", { name: "破棄してもどる" }).click();
  await page.waitForURL((url) => url.pathname === "/");
});

test("UC-C01: カレンダーの日タップでその日の記録シートが開く", async ({
  page,
}) => {
  const marker = `E2E-calendar-${Date.now()}`;
  await login(page);
  await quickRecord(page, marker);

  await page.goto("/calendar");
  // 今日のセル（記録あり）をタップ → 日別シートに今日の記録が出る
  await page
    .getByRole("button", { name: /記録\d+件/ })
    .last()
    .click();
  const sheet = page.getByRole("dialog", { name: /の記録$/ });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText(marker)).toBeVisible();
  await expect(
    sheet.getByRole("link", { name: "この日の記録を追加" }),
  ).toBeVisible();

  // シートの記録行から詳細へ
  await sheet.getByText(marker).click();
  await page.waitForURL(/\/records\/[0-9a-f-]{36}/);
});

test("UC-D01: 記録詳細の「…」から確認つきで削除できる", async ({ page }) => {
  const marker = `E2E-delete-${Date.now()}`;
  await login(page);
  await quickRecord(page, marker);

  // いま作った記録（先頭カード）を開く
  await page.locator("main ul > li").first().click();
  await page.waitForURL(/\/records\/[0-9a-f-]{36}/);
  await expect(page.getByText(marker)).toBeVisible();

  await page.getByRole("button", { name: "その他の操作" }).click();
  const sheet = page.getByRole("dialog", { name: "その他の操作" });
  await expect(sheet).toBeVisible();

  await sheet.getByRole("button", { name: "この記録を削除する" }).click();
  await expect(
    sheet.getByText("この記録を削除しますか？"),
  ).toBeVisible();
  await sheet.getByRole("button", { name: "削除する" }).click();

  // 削除後は一覧へ戻り、記録は消えている
  await page.waitForURL((url) => url.pathname === "/");
  await expect(page.getByText(marker)).not.toBeVisible();
});
