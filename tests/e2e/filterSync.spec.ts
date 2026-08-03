import { test, expect } from "@playwright/test";
import { login, quickRecord } from "./helpers";

// URL クエリ同期（?q= ほか）: 絞り込み状態が URL に載り、リロードで再現されること。
// parse→build→parse の不変性は Unit 層（recordQuery）が守っているので、
// ここは「ブラウザのリロードをまたいで UI と一覧が同じ状態に戻る」ことだけを見る。

test("UC-F01: キーワード絞り込みが URL に載り、リロードしても再現される", async ({
  page,
}) => {
  const markerA = `E2E-filter-A-${Date.now()}`;
  const markerB = `E2E-filter-B-${Date.now()}`;

  await login(page);
  await quickRecord(page, markerA);
  await quickRecord(page, markerB);
  await expect(page.getByText(markerB)).toBeVisible();

  // 検索パネルは既定で畳まれている（UC-H01）。開いてからキーワードで絞り込む
  await page.getByRole("button", { name: "検索・絞り込み" }).click();
  await page.getByPlaceholder("本文・記入者で検索").fill(markerA);
  await page.getByRole("button", { name: "検索", exact: true }).click();
  await page.waitForURL((url) => url.searchParams.get("q") === markerA);
  await expect(page.getByText(markerA)).toBeVisible();
  await expect(page.getByText(markerB)).not.toBeVisible();

  // リロードしても URL・入力欄・一覧が同じ状態に戻る
  await page.reload();
  await expect(page.getByPlaceholder("本文・記入者で検索")).toHaveValue(markerA);
  await expect(page.getByText(markerA)).toBeVisible();
  await expect(page.getByText(markerB)).not.toBeVisible();
});
