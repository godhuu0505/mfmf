import { expect, type Page } from "@playwright/test";
import { E2E_USER } from "./global-setup";

// spec 横断の共通操作。全 spec が同一の E2E ユーザーを共有する
// （playwright.config.ts で workers: 1 に固定している前提）。

export async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("メールアドレス").fill(E2E_USER.email);
  await page.getByLabel("パスワード").fill(E2E_USER.password);
  await page.getByRole("button", { name: "メールアドレスでログイン" }).click();
  await page.waitForURL("**/");
  await expect(page.getByRole("heading", { name: "記録一覧" })).toBeVisible();
}

// クイック記録シートでひとことだけの記録を 1 件残す（テキスト経路の最短）
export async function quickRecord(page: Page, note: string): Promise<void> {
  await page.getByRole("button", { name: "クイック記録" }).click();
  const sheet = page.getByRole("dialog", { name: "クイック記録" });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "＋ ひとことを足す" }).click();
  await sheet.getByPlaceholder("ひとこと（任意）").fill(note);
  await sheet.getByRole("button", { name: "保存する" }).click();
  await expect(sheet).not.toBeVisible();
}
