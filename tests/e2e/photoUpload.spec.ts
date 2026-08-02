import { test, expect, type Request } from "@playwright/test";
import { login } from "./helpers";

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

// 写真つき記録（System 層でしか捕まらない 2 点を 1 本で担保する）:
// 1. ブラウザでの縮小・JPEG 再圧縮（imageResize.ts。createImageBitmap / canvas.toBlob
//    が jsdom に無いため Unit 層は対象外 = D30）
// 2. クライアントから Supabase Storage への直接アップロード（Server Action を経由しない経路）

test("UC-P01: 長辺 1600px を超える写真が縮小されて記録に付き、詳細で表示できる", async ({
  page,
}) => {
  await login(page);
  await page.goto("/records/new");

  await page
    .getByPlaceholder("今日の様子などを記録します")
    .fill("E2E: 写真つき記録（3000x2000 を投入）");

  // 3000x2000 の画像をブラウザ内で生成して file input に投入する。
  // ノイズを乗せて JPEG が十分な大きさになるようにする（グラデーションだけだと
  // 圧縮されすぎて「Server Action の本文に画像が入っていない」判定が曖昧になる）。
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 3000;
    canvas.height = 2000;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2d context が取れない");
    const grad = ctx.createLinearGradient(0, 0, 3000, 2000);
    grad.addColorStop(0, "#f59e0b");
    grad.addColorStop(1, "#0ea5e9");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 3000, 2000);
    const noise = ctx.getImageData(0, 0, 3000, 2000);
    for (let i = 0; i < noise.data.length; i += 4) {
      const n = (Math.random() - 0.5) * 80;
      noise.data[i] += n;
      noise.data[i + 1] += n;
      noise.data[i + 2] += n;
    }
    ctx.putImageData(noise, 0, 0);
    const blob: Blob = await new Promise((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("toBlob 失敗"))),
        "image/png",
      ),
    );
    const file = new File([blob], "e2e-photo.png", { type: "image/png" });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("file input が見つからない");
    input.files = dt.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });

  // クライアント側の縮小・再圧縮が完了するまで待つ
  await expect(page.getByText(/最適化しました|スキップしました/)).toBeVisible({
    timeout: 15_000,
  });
  // 縮小がスキップされていたら System 層の担保対象（imageResize）が働いていない
  await expect(page.getByText(/スキップしました/)).not.toBeVisible();

  // 保存時のネットワークを記録し、「どの経路で画像が運ばれたか」を確かめる。
  // 画面遷移が通るだけでは、Server Action 経由のアップロードへ退行しても
  // 緑のままになる（Vercel の本文 4.5MB 制限で本番だけ壊れる退行）。
  const captured: Request[] = [];
  page.on("request", (req) => {
    captured.push(req);
  });

  // 保存 = Storage へ直接アップロード → メタデータだけ Server Action → 詳細へ
  await page.getByRole("button", { name: "保存する" }).click();
  await page.waitForURL(/\/records\/[0-9a-f-]{36}/, { timeout: 30_000 });

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

  // 詳細ページで署名付き URL の写真が実際に表示され、長辺が 1600px 以下になっている
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
  expect(Math.max(size.w, size.h)).toBeLessThanOrEqual(1600);
  expect(Math.max(size.w, size.h)).toBeGreaterThan(0);
  // アスペクト比が保たれている（3:2）
  expect(size.w / size.h).toBeCloseTo(3 / 2, 1);

  // 保存された実体が JPEG に再圧縮されている（PNG のままでは寸法検査は通ってしまう）
  const contentType = await photo.evaluate(async (el) => {
    const res = await fetch((el as HTMLImageElement).currentSrc);
    return res.headers.get("content-type");
  });
  expect(contentType).toContain("image/jpeg");
});
