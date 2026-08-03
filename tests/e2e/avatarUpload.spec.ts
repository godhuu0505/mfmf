import { test, expect, type Request } from "@playwright/test";
import { login } from "./helpers";

// アバター画像アップロード（System 層でしか捕まらない点を photoUpload.spec と同型で担保する）:
// 1. ブラウザでの縮小・JPEG 再圧縮（アバターは長辺 512px。createImageBitmap /
//    canvas.toBlob が jsdom に無いため Unit 層は対象外 = D30）
// 2. クライアントから avatars バケットへの直接アップロード（Server Action を経由しない経路。
//    退行すると Vercel の本文 4.5MB 制限で本番だけ壊れる）
// 3. private バケットの署名付き URL で表示されること
//
// なお「Service Worker が署名付き URL をキャッシュしない」不変条件は
// serviceWorker.spec.ts が /storage/v1/ 全体を監視しているため avatars も自動でカバーされる。

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

test("UC-M03: /settings/account でアバターが 512px に縮小して直接アップロードされ、署名付き URL で表示される", async ({
  page,
}) => {
  await login(page);
  await page.goto("/settings/account");
  await expect(
    page.getByRole("heading", { name: "アカウント設定" }),
  ).toBeVisible();

  // ローカル再実行で前回のアバターが残っていたら先に消して初期状態に揃える
  // （CI は毎回まっさらなのでこの分岐は通らない）
  const removeButton = page.getByRole("button", { name: "画像を削除" });
  if ((await removeButton.count()) > 0) {
    await removeButton.click();
    await expect(
      page.getByRole("button", { name: "画像を選ぶ" }),
    ).toBeVisible();
  }

  // 保存時のネットワークを記録し、「どの経路で画像が運ばれたか」を確かめる。
  // 画面が更新されるだけでは、Server Action 経由のアップロードへ退行しても緑のままになる。
  const captured: Request[] = [];
  page.on("request", (req) => {
    captured.push(req);
  });

  // 1024x768（長辺 > 512）のノイズ入り生成画像を file input へ注入する。
  // ノイズを乗せて JPEG が十分な大きさになるようにする（グラデーションだけだと
  // 圧縮されすぎて「画像本体が直接アップロードに載っている」判定が曖昧になる）
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 1024;
    canvas.height = 768;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2d context が取れない");
    const grad = ctx.createLinearGradient(0, 0, 1024, 768);
    grad.addColorStop(0, "#f59e0b");
    grad.addColorStop(1, "#0ea5e9");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 1024, 768);
    const noise = ctx.getImageData(0, 0, 1024, 768);
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
    const file = new File([blob], "e2e-avatar.png", { type: "image/png" });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("file input が見つからない");
    input.files = dt.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });

  // アップロード → Server Action → 再描画で「画像を変更」に変わるまで待つ
  await expect(page.getByRole("button", { name: "画像を変更" })).toBeVisible({
    timeout: 15_000,
  });

  // 1. ブラウザから Storage API への直接アップロードが実際に起きており、画像本体が載っている
  const storageUploads = captured.filter(
    (r) => r.method() === "POST" && r.url().includes("/storage/v1/object/"),
  );
  expect(storageUploads.length).toBeGreaterThan(0);
  expect(await bodyBytes(storageUploads[0])).toBeGreaterThan(30_000);

  // 2. Server Action（同一オリジンへの POST）の本文はパスだけで、画像は載っていない
  const actionPosts = captured.filter(
    (r) => r.method() === "POST" && !r.url().includes("/storage/v1/"),
  );
  expect(actionPosts.length).toBeGreaterThan(0);
  for (const post of actionPosts) {
    expect(await bodyBytes(post)).toBeLessThan(20_000);
  }

  // 3. 署名付き URL のアバターが実際に表示される
  const avatar = page.locator('main img[alt="あなたのアバター"]');
  await expect(avatar).toBeVisible();
  await expect
    .poll(
      () =>
        avatar.evaluate((el) => {
          const img = el as HTMLImageElement;
          return img.complete && img.naturalWidth > 0
            ? { w: img.naturalWidth, h: img.naturalHeight }
            : null;
        }),
      { timeout: 15_000 },
    )
    .not.toBeNull();

  const src = await avatar.evaluate((el) => (el as HTMLImageElement).currentSrc);
  expect(src).toContain("/storage/v1/object/sign/"); // private バケット + 署名付き URL

  // 契約は「長辺 = 512px」（1024x768 の入力に対して）。≤ だけだと
  // 縮みすぎ（サムネイル級になる退行）が緑のままになる
  const size = await avatar.evaluate((el) => {
    const img = el as HTMLImageElement;
    return { w: img.naturalWidth, h: img.naturalHeight };
  });
  expect(Math.max(size.w, size.h)).toBe(512);
  // アスペクト比が保たれている（4:3）
  expect(size.w / size.h).toBeCloseTo(4 / 3, 1);

  // 保存された実体が JPEG に再圧縮されている（PNG のままでは寸法検査は通ってしまう）
  const contentType = await avatar.evaluate(async (el) => {
    const res = await fetch((el as HTMLImageElement).currentSrc);
    return res.headers.get("content-type");
  });
  expect(contentType).toContain("image/jpeg");

  // 後始末: 削除して初期状態へ戻す（削除経路も UI から一度通す）
  await page.getByRole("button", { name: "画像を削除" }).click();
  await expect(page.getByRole("button", { name: "画像を選ぶ" })).toBeVisible();
  await expect(page.locator('main img[alt="あなたのアバター"]')).toHaveCount(0);
});
