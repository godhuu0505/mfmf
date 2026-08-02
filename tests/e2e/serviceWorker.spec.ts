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
  // Supabase への実リクエスト（署名付きサムネイル）を発生させる
  await page.reload();
  await expect(page.getByRole("heading", { name: "記録一覧" })).toBeVisible();

  // 「ブラウザ発の Supabase リクエスト」が実際に起きてからキャッシュを見る。
  // 一覧クエリは Server Component 側で SW を通らないため、ブラウザ側で SW を
  // 通り得るのは署名付きサムネイルの取得だけ（photoUpload.spec が先に写真を
  // 1 枚作っている前提。読み込み完了前に検査すると空振りの緑になる）
  const thumb = page.locator('main img[src*="/storage/v1/"]').first();
  await expect(thumb).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(() =>
      thumb.evaluate((el) => {
        const img = el as HTMLImageElement;
        return img.complete && img.naturalWidth > 0;
      }),
    )
    .toBe(true);

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

// このテストは認証不要（SW は /login でも登録され、フォールバックは認可と無関係）。
// setOffline は SW の fetch に効かないため、実験フラグ（config で有効化）＋
// route 遮断で「SW から見てもネットワークが死んでいる」状況を作る。
test("SW: オフライン時のナビゲーションは /offline へフォールバックする", async ({
  page,
  context,
}) => {
  await page.goto("/login");
  await waitForServiceWorker(page);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "メールアドレスでログイン" }),
  ).toBeVisible();

  // SW の fetch も含めて全ネットワークを遮断（Cache Storage の参照は網の外なので生きる）
  await context.route("**/*", (route) => route.abort());
  await page.goto("/help").catch(() => {
    // SW がフォールバックを返せなかった場合はこの後の見出しアサーションで落ちる
  });
  await expect(
    page.getByRole("heading", { name: "オフラインです" }),
  ).toBeVisible();
  await context.unroute("**/*");
});
