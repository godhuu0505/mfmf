import { expect, test } from "@playwright/test";
import { issueInviteLink, login } from "./helpers";
import { E2E_USER } from "./global-setup";
import { POST_LOGIN_NEXT_COOKIE } from "../../src/lib/nextPath";

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
  await page.getByLabel("メールアドレス").fill(E2E_USER.email);
  await page.getByLabel("パスワード").fill(E2E_USER.password);
  await page.getByRole("button", { name: "メールアドレスでログイン" }).click();
  await expect(page).toHaveURL(/\/invite\/dummy-token-for-redirect$/);
});

test("ログイン画面の計測送信は招待の戻り先 Cookie を書き換えない", async ({
  page,
  context,
}) => {
  const next = "/invite/telemetry-original";
  await page.goto(next);
  const response = await page.request.post("/api/vitals", {
    data: { name: "FCP", value: 100, path: "/login" },
  });
  expect(response.status()).toBe(204);
  expect((await context.cookies()).find((c) => c.name === POST_LOGIN_NEXT_COOKIE)?.value).toBe(
    encodeURIComponent(next),
  );
});

test("戻り先 Cookie の更新は同一 Origin からだけ許可する", async ({
  page,
  context,
}) => {
  await page.goto("/login");
  const next = "/invite/same-origin-only";
  const allowed = await page.request.post("/auth/next", {
    form: { next },
    headers: { origin: new URL(page.url()).origin },
  });
  expect(allowed.status()).toBe(204);
  const denied = await page.request.post("/auth/next", {
    form: { next: "/invite/cross-origin" },
    headers: { origin: "https://other.example" },
  });
  expect(denied.status()).toBe(403);
  expect((await context.cookies()).find((c) => c.name === POST_LOGIN_NEXT_COOKIE)?.value).toBe(
    encodeURIComponent(next),
  );
});

test("別タブの戻り先を OAuth 開始時に更新し、同意取消後のメールログインでも招待へ戻る", async ({
  page,
  context,
}) => {
  const next = "/invite/oauth-retry-original";
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  const origin = new URL(page.url()).origin;
  // 別タブで別の招待を開き、ブラウザ共通 Cookie が上書きされた状態。
  await context.addCookies([
    {
      name: POST_LOGIN_NEXT_COOKIE,
      value: "/invite/another-tab",
      url: origin,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  // 外部 Google には接続しない。同意を取り消したときと同じ callback を返す。
  await page.route("**/auth/v1/authorize?**", (route) =>
    route.fulfill({
      status: 302,
      headers: { location: `${origin}/auth/callback?error=access_denied` },
    }),
  );

  await page.getByRole("button", { name: "Google でログイン" }).click();
  await expect(page).toHaveURL((url) =>
    url.pathname === "/login" &&
    url.searchParams.get("error") === "oauth" &&
    url.searchParams.get("next") === next,
  );
  await expect(page.getByRole("alert")).toContainText("ログインに失敗しました");
  await page.getByLabel("メールアドレス").fill(E2E_USER.email);
  await page.getByLabel("パスワード").fill(E2E_USER.password);
  await page.getByRole("button", { name: "メールアドレスでログイン" }).click();
  await expect(page).toHaveURL(new RegExp(`${next}$`));
  expect((await context.cookies()).some((c) => c.name === POST_LOGIN_NEXT_COOKIE)).toBe(false);
});

test("回復コード交換に失敗しても、メールログインの戻り先は元の招待になる", async ({
  page,
  context,
}) => {
  const next = "/invite/recovery-retry-original";
  await page.goto(next);
  // ローカル Supabase に無効なコードを渡し、exchangeCodeForSession の失敗を通す。
  await page.goto("/auth/callback?code=invalid-recovery-code&next=%2Freset-password");
  await expect(page).toHaveURL((url) =>
    url.pathname === "/login" &&
    url.searchParams.get("error") === "oauth" &&
    url.searchParams.get("next") === next,
  );
  await page.getByLabel("メールアドレス").fill(E2E_USER.email);
  await page.getByLabel("パスワード").fill(E2E_USER.password);
  await page.getByRole("button", { name: "メールアドレスでログイン" }).click();
  await expect(page).toHaveURL(new RegExp(`${next}$`));
  expect((await context.cookies()).some((c) => c.name === POST_LOGIN_NEXT_COOKIE)).toBe(false);
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
