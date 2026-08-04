import { test, expect } from "@playwright/test";
import { login, quickRecord } from "./helpers";

// P4（proto/app-redesign/spec.md UC-S01 ほか）と、レビューで判明した網羅ギャップの補強。
// 体重の期間切替 / ペット編集シート / 「…」のゲスト共有 / 招待リンクのコピー / 前後ナビ。

test("UC-W01: 体重の期間切替チップが効き、選択状態が分かる", async ({
  page,
}) => {
  await login(page);

  // 体重つきの記録をフォームから作る（保存確認ダイアログつき）
  await page.goto("/records/new");
  await page
    .getByPlaceholder("今日の様子などを記録します")
    .fill("E2E: 体重つき記録");
  await page.getByLabel("体重(kg)").fill("3.21");
  await page.getByRole("button", { name: "保存する" }).click();
  const confirm = page.getByRole("dialog", {
    name: "この内容で保存しますか？",
  });
  await confirm.getByRole("button", { name: "保存する" }).click();
  await page.waitForURL(/\/records\/[0-9a-f-]{36}/);

  await page.goto("/weight");
  await expect(page.getByText("3.21kg").first()).toBeVisible();
  await expect(
    page.getByRole("link", { name: "全期間" }),
  ).toHaveAttribute("aria-current", "page");

  // 1ヶ月へ切替（今日の記録なので期間内に残る）
  await page.getByRole("link", { name: "1ヶ月" }).click();
  await page.waitForURL("**/weight?range=1m");
  await expect(
    page.getByRole("link", { name: "1ヶ月" }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("3.21kg").first()).toBeVisible();
});

test("UC-P01: ペットをカードから編集シートで更新・削除できる", async ({
  page,
}) => {
  const name = `E2Eペット${Date.now()}`;
  const renamed = `${name}改`;
  await login(page);

  // 追加（Server Action + revalidate が遅い runner で 5s を超えることがある）
  await page.goto("/pets");
  await page.getByLabel("名前").fill(name);
  await page.getByRole("button", { name: "追加する" }).click();
  await expect(page.getByText(name, { exact: true })).toBeVisible({
    timeout: 15_000,
  });

  // 編集シートで名前を変更
  await page.getByRole("button", { name: `${name}を編集` }).click();
  const sheet = page.getByRole("dialog", { name: `${name}を編集` });
  await expect(sheet).toBeVisible();
  await sheet.locator('input[name="name"]').fill(renamed);
  await sheet.getByRole("button", { name: "更新する" }).click();
  await expect(page.getByText(renamed, { exact: true })).toBeVisible();

  // 削除は確認ステップを挟む
  await page.getByRole("button", { name: `${renamed}を編集` }).click();
  const sheet2 = page.getByRole("dialog", { name: `${renamed}を編集` });
  await sheet2.getByRole("button", { name: "このペットを削除する" }).click();
  await expect(
    sheet2.getByText(`${renamed}を削除しますか？`),
  ).toBeVisible();
  await sheet2.getByRole("button", { name: "削除する" }).click();
  await expect(page.getByText(renamed, { exact: true })).not.toBeVisible();
});

test("UC-D02: 「…」シートからゲスト共有を切り替えられる", async ({ page }) => {
  const petName = `E2E共有ペット${Date.now()}`;
  await login(page);

  // ペットを用意（記録フォームは先頭ペットを既定選択する）
  await page.goto("/pets");
  await page.getByLabel("名前").fill(petName);
  await page.getByRole("button", { name: "追加する" }).click();
  await expect(page.getByText(petName, { exact: true })).toBeVisible();

  // ペット紐付きの記録を作る
  await page.goto("/records/new");
  await page
    .getByPlaceholder("今日の様子などを記録します")
    .fill("E2E: 共有トグル");
  await page.getByRole("button", { name: "保存する" }).click();
  await page
    .getByRole("dialog", { name: "この内容で保存しますか？" })
    .getByRole("button", { name: "保存する" })
    .click();
  await page.waitForURL(/\/records\/[0-9a-f-]{36}/);

  // 「…」シートに共有アクションがあり、押すと共有状態が反映される
  await page.getByRole("button", { name: "その他の操作" }).click();
  const sheet = page.getByRole("dialog", { name: "その他の操作" });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "ゲストに共有" }).click();
  await expect(page.getByText("共有中:", { exact: false })).toBeVisible();

  // 後片付け（ペット削除。記録は残る仕様）
  await page.goto("/pets");
  await page.getByRole("button", { name: `${petName}を編集` }).click();
  const petSheet = page.getByRole("dialog", { name: `${petName}を編集` });
  await petSheet
    .getByRole("button", { name: "このペットを削除する" })
    .click();
  await petSheet.getByRole("button", { name: "削除する" }).click();
  await expect(page.getByText(petName, { exact: true })).not.toBeVisible();
});

test("UC-D03: 記録詳細の前後ナビで隣の記録へ移動できる", async ({ page }) => {
  await login(page);
  // 記録を 2 件用意（同日 2 件でも created_at 順で隣り合う）
  await quickRecord(page, `E2E-nav-A-${Date.now()}`);
  await quickRecord(page, `E2E-nav-B-${Date.now()}`);

  await page.locator("main ul > li").first().click();
  await page.waitForURL(/\/records\/[0-9a-f-]{36}/);
  const urlBefore = page.url();

  const prev = page.locator('a[rel="prev"]');
  await expect(prev).toBeVisible();
  await prev.click();
  await page.waitForURL((url) => url.toString() !== urlBefore);
  // 移動先にも次の記録リンクが出る
  await expect(page.locator('a[rel="next"]')).toBeVisible();
});

test.describe("招待リンクのコピー", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  test("UC-S02: 招待を発行してリンクをコピーできる", async ({ page }) => {
    const email = `e2e-invite-${Date.now()}@example.com`;
    await login(page);

    await page.goto("/settings");
    await page.locator("#invite_email").fill(email);
    // exact: ペットが居るとゲスト招待フォームの「ゲスト招待を発行」に部分一致する
    await page.getByRole("button", { name: "招待を発行", exact: true }).click();
    await expect(page.getByText(email, { exact: false })).toBeVisible();

    const copyBtn = page
      .getByRole("button", { name: "リンクをコピー" })
      .first();
    await copyBtn.click();
    await expect(page.getByText("コピーしました")).toBeVisible();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toMatch(/\/invite\/.+/);

    // 後片付け: 招待を取り消す
    await page.getByRole("button", { name: "取り消す" }).first().click();
  });
});

test("アルバム: 「アルバム」の名称と月見出しのグループで表示される", async ({
  page,
}) => {
  await login(page);
  // photoUpload.spec（先行実行）が今日の日付で写真つき記録を残している
  await page.goto("/gallery");
  await expect(
    page.getByRole("heading", { name: "アルバム", exact: true }),
  ).toBeVisible();
  // 記録日はアプリ側で JST 基準（CI ランナーは UTC なので合わせる）
  const jstToday = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
  }).format(new Date());
  const [y, m] = jstToday.split("-").map(Number);
  await expect(
    page.getByRole("heading", { name: `${y}年${m}月` }),
  ).toBeVisible();
});
