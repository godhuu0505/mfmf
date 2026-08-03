import { test, expect, type Page } from "@playwright/test";
import { E2E_USER } from "./global-setup";

// クイック記録（proto/quick-record/spec.md の受け入れ条件 UC-Q01〜Q05）。
// D25: この UC 群が通らない限り受け入れ未達。

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("メールアドレス").fill(E2E_USER.email);
  await page.getByLabel("パスワード").fill(E2E_USER.password);
  await page.getByRole("button", { name: "メールアドレスでログイン" }).click();
  await page.waitForURL("**/");
  await expect(
    page.getByRole("heading", { name: "記録一覧" }),
  ).toBeVisible();
}

function sheet(page: Page) {
  return page.getByRole("dialog", { name: "クイック記録" });
}

async function openSheet(page: Page) {
  await page.getByRole("button", { name: "クイック記録" }).click();
  await expect(sheet(page)).toBeVisible();
}

function firstCard(page: Page) {
  return page.locator("main ul > li").first();
}

test("UC-Q01: チップだけで残す（IME 不要・今日/おうちが既定）", async ({
  page,
}) => {
  await login(page);
  await openSheet(page);

  // 既定: おうちが選択済み
  await expect(sheet(page).getByRole("radio", { name: "おうち" })).toHaveAttribute(
    "aria-checked",
    "true",
  );

  await sheet(page).getByRole("button", { name: "ごはん完食" }).click();
  await sheet(page).getByRole("button", { name: "保存する" }).click();

  await expect(sheet(page)).not.toBeVisible();
  await expect(page.getByText("残しました")).toBeVisible();

  const card = firstCard(page);
  await expect(card).toContainText("ごはん完食");
  await expect(card).toContainText("おうち");
  // 日付はカード内ではなく日付グループの見出しに出る（UC-H01）
  await expect(
    page
      .locator("main section")
      .first()
      .getByRole("heading", { name: "今日", exact: false }),
  ).toBeVisible();
});

test("UC-Q02: チップ＋ひとことの合成と、リロード後の永続化", async ({
  page,
}) => {
  const marker = `E2E-${Date.now()}`;
  await login(page);
  await openSheet(page);

  await sheet(page).getByRole("button", { name: "さんぽ" }).click();
  await sheet(page).getByRole("button", { name: "おくすり" }).click();
  await sheet(page).getByRole("button", { name: "＋ ひとことを足す" }).click();
  await sheet(page).getByPlaceholder("ひとこと（任意）").fill(marker);
  await sheet(page).getByRole("button", { name: "保存する" }).click();

  await expect(sheet(page)).not.toBeVisible();
  await expect(firstCard(page)).toContainText(`さんぽ、おくすり、${marker}`);

  // リロードしても残っている（サーバーに保存されている）
  await page.reload();
  await expect(firstCard(page)).toContainText(`さんぽ、おくすり、${marker}`);
});

test("UC-Q03: 本文が空のあいだ保存できない", async ({ page }) => {
  await login(page);
  await openSheet(page);

  const saveBtn = sheet(page).getByRole("button", { name: "保存する" });
  await expect(saveBtn).toBeDisabled();

  await sheet(page).getByRole("button", { name: "おやつ" }).click();
  await expect(saveBtn).toBeEnabled();

  // 外すとまた押せなくなる
  await sheet(page).getByRole("button", { name: "おやつ" }).click();
  await expect(saveBtn).toBeDisabled();
});

test("UC-Q04: 保育園に切り替えて残すとバッジに反映される", async ({
  page,
}) => {
  const marker = `E2E-daycare-${Date.now()}`;
  await login(page);
  await openSheet(page);

  await sheet(page).getByRole("radio", { name: "保育園" }).click();
  await expect(
    sheet(page).getByRole("radio", { name: "保育園" }),
  ).toHaveAttribute("aria-checked", "true");

  await sheet(page).getByRole("button", { name: "＋ ひとことを足す" }).click();
  await sheet(page).getByPlaceholder("ひとこと（任意）").fill(marker);
  await sheet(page).getByRole("button", { name: "保存する" }).click();

  await expect(sheet(page)).not.toBeVisible();
  const card = firstCard(page);
  await expect(card).toContainText(marker);
  await expect(card).toContainText("保育園");

  // 保存後にシートを開き直すと既定（おうち）へ戻っている
  await openSheet(page);
  await expect(sheet(page).getByRole("radio", { name: "おうち" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

test("UC-Q05: Escape で閉じてフォーカスがタブバーの記録ボタンへ戻る", async ({ page }) => {
  await login(page);
  await openSheet(page);

  await page.keyboard.press("Escape");
  await expect(sheet(page)).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "クイック記録" }),
  ).toBeFocused();
});

test("UC-Q06: 絞り込み中の URL から保存しても、絞り込みなしの先頭で見える", async ({
  page,
}) => {
  const marker = `E2E-filtered-${Date.now()}`;
  await login(page);
  // 「保育園のみ・古い順」で絞り込んだ状態からおうちの記録を残す
  await page.goto("/?source=daycare&sort=date_asc");
  await openSheet(page);

  await sheet(page).getByRole("button", { name: "＋ ひとことを足す" }).click();
  await sheet(page).getByPlaceholder("ひとこと（任意）").fill(marker);
  await sheet(page).getByRole("button", { name: "保存する" }).click();

  await expect(sheet(page)).not.toBeVisible();
  // 保存後は絞り込みなしの先頭へ戻り、いま残した記録が見えている
  await page.waitForURL(
    (url) => url.pathname === "/" && url.search === "",
  );
  await expect(firstCard(page)).toContainText(marker);
});
