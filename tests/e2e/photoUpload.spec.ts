import { test, expect, type Request } from "@playwright/test";
import { login, prepareOversizedPhotoForm, savePhotoRecord } from "./helpers";

// 写真つき記録（System 層でしか捕まらない 2 点を 1 本で担保する）:
// 1. ブラウザでの縮小・JPEG 再圧縮（imageResize.ts。createImageBitmap / canvas.toBlob
//    が jsdom に無いため Unit 層は対象外 = D30）
// 2. クライアントから Supabase Storage への直接アップロード（Server Action を経由しない経路）

// リクエスト本文のバイト数。Blob ボディは postDataBuffer で取れない
// （Playwright の制約で null になる）ため、content-length ヘッダで測る。
async function bodyBytes(req: Request): Promise<number> {
  const buf = req.postDataBuffer();
  if (buf) return buf.length;
  const headers = await req
    .allHeaders()
    .catch(() => ({}) as Record<string, string>);
  return Number(headers["content-length"] ?? 0);
}

test("UC-P01: 長辺 1600px を超える写真が縮小されて記録に付き、詳細で表示できる", async ({
  page,
}) => {
  await login(page);
  await prepareOversizedPhotoForm(page, "E2E: 写真つき記録（3000x2000 を投入）");

  // 保存時のネットワークを記録し、「どの経路で画像が運ばれたか」を確かめる。
  // 画面遷移が通るだけでは、Server Action 経由のアップロードへ退行しても
  // 緑のままになる（Vercel の本文 4.5MB 制限で本番だけ壊れる退行）。
  const captured: Request[] = [];
  page.on("request", (req) => {
    captured.push(req);
  });

  // 保存 = Storage へ直接アップロード → メタデータだけ Server Action → 詳細へ
  await savePhotoRecord(page);

  // 1. ブラウザから Storage API への直接アップロードが実際に起きている
  const storageUploads = captured.filter(
    (r) => r.method() === "POST" && r.url().includes("/storage/v1/object/"),
  );
  expect(storageUploads.length).toBeGreaterThan(0);
  expect(await bodyBytes(storageUploads[0])).toBeGreaterThan(100_000); // 画像本体が載っている

  // 2. Server Action（同一オリジンへの POST）の本文はメタデータだけで、画像は載っていない
  const actionPosts = captured.filter(
    (r) => r.method() === "POST" && !r.url().includes("/storage/v1/"),
  );
  expect(actionPosts.length).toBeGreaterThan(0);
  for (const post of actionPosts) {
    expect(await bodyBytes(post)).toBeLessThan(50_000);
  }

  // 詳細ページで署名付き URL の写真が実際に表示される
  const photo = page.locator("main img").first();
  await expect(photo).toBeVisible();
  await expect
    .poll(
      () =>
        photo.evaluate((el) => {
          const img = el as HTMLImageElement;
          return img.complete && img.naturalWidth > 0
            ? { w: img.naturalWidth, h: img.naturalHeight }
            : null;
        }),
      { timeout: 15_000 },
    )
    .not.toBeNull();

  const size = await photo.evaluate((el) => {
    const img = el as HTMLImageElement;
    return { w: img.naturalWidth, h: img.naturalHeight };
  });
  // 契約は「長辺 = 1600px」（3000x2000 の入力に対して）。≤ だけだと
  // サムネイル級まで縮む退行が緑のままになる
  expect(Math.max(size.w, size.h)).toBe(1600);
  // アスペクト比が保たれている（3:2）
  expect(size.w / size.h).toBeCloseTo(3 / 2, 1);

  // 保存された実体が JPEG に再圧縮されている（PNG のままでは寸法検査は通ってしまう）
  const contentType = await photo.evaluate(async (el) => {
    const res = await fetch((el as HTMLImageElement).currentSrc);
    return res.headers.get("content-type");
  });
  expect(contentType).toContain("image/jpeg");
});
