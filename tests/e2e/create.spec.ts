import { test, expect, type Page } from "@playwright/test";
import { login } from "./helpers";

// 作成シート（D36: クイック記録を廃止し、タブバー中央を「作成」にして
// 予定 / 記録の二択にした）。旧 UC-Q01〜Q07 の置き換え。

/** JST の今日（アプリと同じ基準。CI ランナーは UTC）。 */
function jstToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(
    new Date(),
  );
}

function sheet(page: Page) {
  return page.getByRole("dialog", { name: "作成" });
}

async function openSheet(page: Page) {
  await page.getByRole("button", { name: "作成" }).click();
  await expect(sheet(page)).toBeVisible();
}

test("UC-N04: 中央ボタンは「作成」で、予定と記録を選べる", async ({ page }) => {
  await login(page);
  const tabbar = page.getByRole("navigation", { name: "メインナビゲーション" });
  await expect(tabbar.getByRole("button", { name: "作成" })).toContainText(
    "作成",
  );

  await openSheet(page);
  await expect(sheet(page).getByRole("button", { name: /^予定/ })).toBeVisible();
  await expect(sheet(page).getByRole("button", { name: /^記録/ })).toBeVisible();
  // クイック記録の定型チップはもう出ない
  await expect(
    sheet(page).getByRole("button", { name: "ごはん完食" }),
  ).toHaveCount(0);
});

test("UC-N05: 「記録」を選ぶと記録フォームへ移り、保存すると一覧の先頭に出る", async ({
  page,
}) => {
  const marker = `E2E-create-record-${Date.now()}`;
  await login(page);
  await openSheet(page);

  await sheet(page).getByRole("button", { name: /^記録/ }).click();
  await page.waitForURL("**/records/new**");
  await expect(sheet(page)).not.toBeVisible();

  await page.getByPlaceholder("今日の様子などを記録します").fill(marker);
  await page.getByRole("button", { name: "保存する" }).click();
  await page
    .getByRole("dialog", { name: "この内容で保存しますか？" })
    .getByRole("button", { name: "保存する" })
    .click();
  await page.waitForURL(/\/records\/[0-9a-f-]{36}/);

  await page.goto("/");
  await expect(page.locator("main ul > li").first()).toContainText(marker);
});

test("UC-N06: 「予定」を選ぶとカレンダーの今日のシートが開く（ホームから）", async ({
  page,
}) => {
  await login(page);
  await openSheet(page);

  await sheet(page).getByRole("button", { name: /^予定/ }).click();
  await page.waitForURL("**/calendar**");
  const daySheet = page.getByRole("dialog", { name: /の予定$/ });
  await expect(daySheet).toBeVisible();
  await expect(daySheet).toContainText("予定を保存する");
});

test("UC-N07: カレンダーを開いたままでも「予定」から今日のシートが開く", async ({
  page,
}) => {
  await login(page);
  await page.goto(`/calendar?ym=${jstToday().slice(0, 7)}`);

  await openSheet(page);
  await sheet(page).getByRole("button", { name: /^予定/ }).click();
  await expect(page.getByRole("dialog", { name: /の予定$/ })).toBeVisible();
});

test("UC-N08: Escape で閉じてフォーカスがタブバーの作成ボタンへ戻る", async ({
  page,
}) => {
  await login(page);
  await openSheet(page);

  await page.keyboard.press("Escape");
  await expect(sheet(page)).not.toBeVisible();
  await expect(page.getByRole("button", { name: "作成" })).toBeFocused();
});
