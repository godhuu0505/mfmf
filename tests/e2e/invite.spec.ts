import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

// 招待リンク（/invite/{token}）の受入条件（UC-O09〜O10 / D12・D13）。
//
// 背景: 招待ページは「宛先メール一致」を見ておらず、owner には他人宛ての招待も
// 見える（RLS invites_select_owner）ため、招待した本人がリンクを確認すると
// 受諾ボタンが出て、押すと accept_household_invite が弾いて例外 →
// 画面全体が Next の「Application error」に置き換わっていた。

const INVITEE = "invitee-e2e@example.com";

// owner として招待を 1 件発行し、その招待リンクの絶対 URL を返す。
// リンクはコピーボタン経由で取り出す（本番と同じ導線）。
async function issueInviteLink(page: Page): Promise<string> {
  await page
    .context()
    .grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(page.url()).origin,
    });

  await page.goto("/settings");
  // ゲスト招待にも同名ラベルの入力があるので id で取る
  await page.locator("#invite_email").fill(INVITEE);
  await page.getByRole("button", { name: "招待を発行" }).click();

  const item = page.locator("li", { hasText: INVITEE }).first();
  await expect(item).toBeVisible();
  await item.getByRole("button", { name: "リンクをコピー" }).click();
  return page.evaluate(() => navigator.clipboard.readText());
}

test("未ログインで招待リンクを開くと、ログイン後に招待へ戻れる（?next=）", async ({
  page,
}) => {
  await page.goto("/invite/dummy-token-for-redirect");
  await expect(page).toHaveURL(/\/login\?next=%2Finvite%2Fdummy-token-for-redirect/);
});

test("宛先と違うアカウントで開くと、受諾ボタンではなく理由が出る", async ({
  page,
}) => {
  await login(page);
  const link = await issueInviteLink(page);

  await page.goto(link);
  await expect(
    page.getByText("宛てですが、いまログインしているのは"),
  ).toBeVisible();
  await expect(page.getByText(INVITEE)).toBeVisible();
  // 押せば必ず失敗するボタンは出さない（これがエラー画面の原因だった）
  await expect(
    page.getByRole("button", { name: "この世帯に参加する" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "別のアカウントでログインし直す" }),
  ).toBeVisible();
});

test("存在しない token は「見つかりません」を出す（例外にしない）", async ({
  page,
}) => {
  await login(page);
  await page.goto("/invite/this-token-does-not-exist");
  await expect(page.getByText("この招待は見つかりませんでした")).toBeVisible();
  await expect(page.getByText("Application error")).toHaveCount(0);
});
