import { test, expect } from "@playwright/test";
import { login } from "./helpers";
import { interceptRelatedSearch, RELATED_FIXTURE, relatedResponse } from "./related-search-helpers";

test.describe("UC-R: 関連度で記録を探す", () => {
  test.skip(Date.now() >= Date.parse("2027-06-24T00:00:00+09:00"), "固定の利用期限後は関連度UIを表示しない");
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.getByRole("button", { name: "検索・絞り込み" }).click();
  });

  test("UC-R01/R02: 明示ボタンだけが送信し、関連順の結果と元記録リンクを表示する", async ({ page }) => {
    const transport = await interceptRelatedSearch(page);
    await page.getByPlaceholder("本文・記入者で検索").fill("保育園から帰ってゆっくりした日");
    await page.locator('input[name="from"]').fill("2026-10-01");
    expect(transport.calls()).toBe(0);
    await expect(page.getByText(/完全な匿名化は保証できません/)).toBeVisible();
    await page.getByRole("button", { name: "関連度で探す", exact: true }).click();
    const result = page.getByRole("region", { name: "関連度の検索結果" });
    await expect(result).toBeVisible();
    await expect(result.locator("article")).toHaveCount(2);
    await expect(result.locator("article").first()).toContainText(RELATED_FIXTURE.records[0].body);
    await expect(result.getByRole("link").first()).toHaveAttribute("href", `/records/${RELATED_FIXTURE.records[0].id}`);
    expect(transport.calls()).toBe(1);
    await page.getByRole("button", { name: "通常検索に戻す", exact: true }).click();
    await expect(result).not.toBeVisible();
    await expect(page.getByRole("button", { name: "検索", exact: true })).toBeEnabled();
  });

  test("UC-R03/R04: 入力変更は処理中の応答を無効にし、遅れて届く結果で入力を消さない", async ({ page }) => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const transport = await interceptRelatedSearch(page, async () => { await waiting; return RELATED_FIXTURE; });
    const input = page.getByPlaceholder("本文・記入者で検索");
    await input.fill("ゆっくりした日");
    await page.getByRole("button", { name: "関連度で探す", exact: true }).click();
    await expect(page.getByRole("button", { name: "関連度を確認中…", exact: true })).toBeDisabled();
    await input.fill("いま入力した別の条件");
    const returned = page.waitForResponse((response) => response.request().method() === "POST" && Boolean(response.request().headers()["next-action"]));
    release();
    await (await returned).finished();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(input).toHaveValue("いま入力した別の条件");
    await expect(page.getByRole("region", { name: "関連度の検索結果" })).not.toBeVisible();
    await expect(page.getByRole("button", { name: "関連度で探す", exact: true })).toBeEnabled();
    expect(transport.calls()).toBe(1);
  });

  test("UC-R04: 処理中に通常検索へ戻ると、遅れた結果を再表示しない", async ({ page }) => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    await interceptRelatedSearch(page, async () => { await waiting; return RELATED_FIXTURE; });
    await page.getByPlaceholder("本文・記入者で検索").fill("ゆっくりした日");
    await page.getByRole("button", { name: "関連度で探す", exact: true }).click();
    await expect(page.getByRole("button", { name: "関連度を確認中…", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "通常検索に戻す", exact: true }).click();
    const returned = page.waitForResponse((response) => Boolean(response.request().headers()["next-action"]));
    release(); await (await returned).finished();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByRole("region", { name: "関連度の検索結果" })).not.toBeVisible();
    await expect(page.getByRole("button", { name: "関連度で探す", exact: true })).toBeEnabled();
  });

  test("UC-R03: 日付変更で既存の関連結果を閉じる", async ({ page }) => {
    await interceptRelatedSearch(page);
    await page.getByPlaceholder("本文・記入者で検索").fill("室内で遊んだ日");
    await page.getByRole("button", { name: "関連度で探す", exact: true }).click();
    await expect(page.getByRole("region", { name: "関連度の検索結果" })).toBeVisible();
    await page.locator('input[name="to"]').fill("2026-10-20");
    await expect(page.getByRole("region", { name: "関連度の検索結果" })).not.toBeVisible();
  });

  test("UC-R02/R03: 連打は1回だけ送信し、並び替え変更で遅い結果を無効にする", async ({ page }) => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const transport = await interceptRelatedSearch(page, async () => { await waiting; return RELATED_FIXTURE; });
    await page.getByPlaceholder("本文・記入者で検索").fill("ゆっくりした日");
    await page.getByRole("button", { name: "関連度で探す", exact: true }).dblclick();
    await expect(page.getByRole("button", { name: "関連度を確認中…", exact: true })).toBeDisabled();
    await page.getByRole("combobox", { name: "並び替え" }).selectOption("date_asc");
    const returned = page.waitForResponse((response) => Boolean(response.request().headers()["next-action"]));
    release(); await (await returned).finished();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(transport.calls()).toBe(1);
    await expect(page.getByRole("region", { name: "関連度の検索結果" })).not.toBeVisible();
    await expect(page.getByRole("combobox", { name: "並び替え" })).toHaveValue("date_asc");
  });

  test("UC-R04: パネルを閉じて開き直した後の遅い失敗を表示しない", async ({ page }) => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    await interceptRelatedSearch(page, async () => { await waiting; return relatedResponse("unavailable"); });
    await page.getByPlaceholder("本文・記入者で検索").fill("ゆっくりした日");
    await page.getByRole("button", { name: "関連度で探す", exact: true }).click();
    await expect(page.getByRole("button", { name: "関連度を確認中…", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "検索・絞り込み" }).click();
    await expect(page.locator("#record-filters-panel")).not.toBeVisible();
    await page.getByRole("button", { name: "検索・絞り込み" }).click();
    const returned = page.waitForResponse((response) => Boolean(response.request().headers()["next-action"]));
    release(); await (await returned).finished();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.locator("#related-search-status")).not.toBeVisible();
    await expect(page.getByRole("button", { name: "関連度で探す", exact: true })).toBeEnabled();
  });

  for (const [status, notice] of [["empty", "記録はありません"], ["limited", "利用上限"], ["disabled", "現在利用できません"], ["unavailable", "確認できませんでした"]] as const) {
    test(`UC-R05: ${status} では古い結果を残さず通常検索を使える`, async ({ page }) => {
      await interceptRelatedSearch(page, () => relatedResponse(status));
      await page.getByPlaceholder("本文・記入者で検索").fill("ゆっくりした日");
      await page.getByRole("button", { name: "関連度で探す", exact: true }).click();
      await expect(page.locator("#related-search-status")).toContainText(notice);
      await expect(page.getByRole("region", { name: "関連度の検索結果" })).not.toBeVisible();
      await expect(page.getByRole("button", { name: "検索", exact: true })).toBeEnabled();
    });
  }
});
