import { expect, test } from "@playwright/test";
import { issueInviteLink, login } from "./helpers";

// 招待リンク（/invite/{token}）の受入条件（UC-O09〜O10 / D12・D13）。
//
// 背景: 招待ページは「宛先メール一致」を見ておらず、owner には他人宛ての招待も
// 見える（RLS invites_select_owner）ため、招待した本人がリンクを確認すると
// 受諾ボタンが出て、押すと accept_household_invite が弾いて例外 →
// 画面全体が Next の「Application error」に置き換わっていた。

test("未ログインで招待リンクを開くと、ログイン後に招待へ戻れる（?next=）", async ({
  page,
}) => {
  await page.goto("/invite/dummy-token-for-redirect");
  await expect(page).toHaveURL(
    /\/login\?next=%2Finvite%2Fdummy-token-for-redirect/,
  );
});

test.describe("宛先違いの受諾", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  test("受諾ボタンではなく理由とログインし直す導線が出る", async ({ page }) => {
    const email = `e2e-invitee-${Date.now()}@example.com`;
    await login(page);
    const link = await issueInviteLink(page, email);

    await page.goto(link);
    await expect(
      page.getByText("宛てですが、いまログインしているのは"),
    ).toBeVisible();
    await expect(page.getByText(email, { exact: false })).toBeVisible();
    // 押せば必ず失敗するボタンは出さない（これがエラー画面の原因だった）
    await expect(
      page.getByRole("button", { name: "この世帯に参加する" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "別のアカウントでログインし直す" }),
    ).toBeVisible();

    // 後片付け: 招待を取り消す
    await page.goto("/settings");
    await page
      .locator("li", { hasText: email })
      .first()
      .getByRole("button", { name: "取り消す" })
      .click();
  });
});

test("開けない token は理由とログインし直す導線を出す（例外にしない）", async ({
  page,
}) => {
  await login(page);
  await page.goto("/invite/this-token-does-not-exist");
  // 宛先と違うアカウントの場合、RLS が行ごと隠すのでここに来る（いちばん多い経路）
  await expect(page.getByText("では開けません")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "別のアカウントでログインし直す" }),
  ).toBeVisible();
  await expect(page.getByText("Application error")).toHaveCount(0);
});
