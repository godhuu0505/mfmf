import { test, expect, type Page } from "@playwright/test";
import { login } from "./helpers";

// Service Worker の不変条件（CLAUDE.md 厳守事項 / D23）:
// 「Supabase の API レスポンスと署名付き写真 URL をキャッシュしない」。
// 「エラーが出ない」では通ってしまうため、Cache Storage の中身を能動的に列挙して
// 確かめる（V4）。静的アセットがキャッシュされていることを正の対照にし、
// 「そもそも何もキャッシュされていないから緑」も排除する。

async function waitForServiceWorker(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
}

async function listCachedUrls(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const req of await cache.keys()) urls.push(req.url);
    }
    return urls;
  });
}

test("SW: 静的アセットはキャッシュされ、Supabase 由来は一切キャッシュされない", async ({
  page,
}) => {
  await login(page);
  await waitForServiceWorker(page);
  // SW 制御下でもう一度読み込み、静的アセットのキャッシュと
  // Supabase への実リクエスト（REST・署名付きサムネイル）を発生させる
  await page.reload();
  await expect(page.getByRole("heading", { name: "記録一覧" })).toBeVisible();

  // 正の対照: 静的アセットのキャッシュが実際に発生している
  await expect
    .poll(async () => (await listCachedUrls(page)).length, { timeout: 15_000 })
    .toBeGreaterThan(0);

  const urls = await listCachedUrls(page);
  // Supabase 由来（別オリジンの API / Storage / Auth、および署名付き URL）がゼロ件
  const banned = urls.filter(
    (u) =>
      u.includes("54321") ||
      u.includes("supabase") ||
      u.includes("/rest/v1/") ||
      u.includes("/auth/v1/") ||
      u.includes("/storage/v1/"),
  );
  expect(banned).toEqual([]);
});

test("SW: オフライン時のナビゲーションは /offline へフォールバックする", async ({
  page,
  context,
}) => {
  await login(page);
  await waitForServiceWorker(page);
  await page.reload();
  await expect(page.getByRole("heading", { name: "記録一覧" })).toBeVisible();

  await context.setOffline(true);
  await page.goto("/calendar").catch(() => {
    // SW がフォールバックを返せなかった場合はこの後の見出しアサーションで落ちる
  });
  await expect(
    page.getByRole("heading", { name: "オフラインです" }),
  ).toBeVisible();
  await context.setOffline(false);
});
