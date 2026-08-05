import { test, expect, type Locator } from "@playwright/test";
import { login } from "./helpers";

// 検索パネルの「期間」の当たり判定（レイアウト回帰）。
// iOS Safari の input[type="date"] はネイティブ表示の固有幅（実測: iPhone 16 Pro /
// 402px 幅で 187px）を下限に持ち、`width: 100%` を指定しても親より小さくならない。
// 固定 2 列（grid-cols-2）だと隣の列へはみ出し、開始日 / 終了日 の入力欄が重なって
// カードからもはみ出していた。globals.css で下限を解除しつつ、レイアウト側も
// 「入らなければ折り返す」flex にしてある。
// Chromium は固有幅が小さく素では再現しないので、同じ下限を注入して確かめる。

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error("要素の矩形が取れない（非表示）");
  return { left: b.x, right: b.x + b.width, top: b.y, bottom: b.y + b.height };
}

test("検索パネル: 開始日 / 終了日 が重ならず、パネル内に収まる", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "検索・絞り込み" }).click();

  const panel = page.locator("#record-filters-panel");
  const from = panel.locator('input[name="from"]');
  const to = panel.locator('input[name="to"]');
  await expect(from).toBeVisible();

  // 0px = 下限が解除できた環境（横並び）、187px = 解除できなかった環境（折り返し）。
  // どちらでも重ならず、パネルからはみ出さないことを求める。
  for (const minWidth of ["0px", "187px"]) {
    await page.addStyleTag({
      content: `#record-filters-panel input[type="date"] { min-width: ${minWidth} !important }`,
    });

    const [p, f, t] = [await box(panel), await box(from), await box(to)];
    const overlaps =
      Math.min(f.right, t.right) - Math.max(f.left, t.left) > 0 &&
      Math.min(f.bottom, t.bottom) - Math.max(f.top, t.top) > 0;

    expect(
      overlaps,
      `min-width:${minWidth} で 開始日 と 終了日 が重なっている`,
    ).toBe(false);
    // 端数の丸めぶんだけ許容する
    expect(
      f.right,
      `min-width:${minWidth} で 開始日 がパネルからはみ出した`,
    ).toBeLessThanOrEqual(p.right + 1);
    expect(
      t.right,
      `min-width:${minWidth} で 終了日 がパネルからはみ出した`,
    ).toBeLessThanOrEqual(p.right + 1);
  }
});
