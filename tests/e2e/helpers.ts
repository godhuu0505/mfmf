import { expect, type Page } from "@playwright/test";
import { E2E_USER } from "./global-setup";

// spec 横断の共通操作。全 spec が同一の E2E ユーザーを共有する
// （playwright.config.ts で workers: 1 に固定している前提）。

export async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("メールアドレス").fill(E2E_USER.email);
  await page.getByLabel("パスワード").fill(E2E_USER.password);
  await page.getByRole("button", { name: "メールアドレスでログイン" }).click();
  await page.waitForURL("**/");
  await expect(page.getByRole("heading", { name: "記録一覧" })).toBeVisible();
}

// クイック記録シートでひとことだけの記録を 1 件残す（テキスト経路の最短）
export async function quickRecord(page: Page, note: string): Promise<void> {
  await page.getByRole("button", { name: "クイック記録" }).click();
  const sheet = page.getByRole("dialog", { name: "クイック記録" });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "＋ ひとことを足す" }).click();
  await sheet.getByPlaceholder("ひとこと（任意）").fill(note);
  await sheet.getByRole("button", { name: "保存する" }).click();
  await expect(sheet).not.toBeVisible();
}

// /records/new で 3000x2000 の生成画像を選択し、クライアント側の縮小完了まで待つ。
// photoUpload.spec の検証と、serviceWorker.spec の「署名付きサムネイルが存在する」
// 前提づくりの両方から使う（spec 間の実行順依存を作らないため、各 spec が自前で呼ぶ）。
export async function prepareOversizedPhotoForm(
  page: Page,
  body: string,
): Promise<void> {
  await page.goto("/records/new");
  await page.getByPlaceholder("今日の様子などを記録します").fill(body);

  // ノイズを乗せて JPEG が十分な大きさになるようにする（グラデーションだけだと
  // 圧縮されすぎて「Server Action の本文に画像が入っていない」判定が曖昧になる）
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

  await expect(page.getByText(/最適化しました|スキップしました/)).toBeVisible({
    timeout: 15_000,
  });
  // 縮小がスキップされていたら imageResize が働いていない
  await expect(page.getByText(/スキップしました/)).not.toBeVisible();
}

// 写真つき記録を保存して詳細ページへ遷移するまで待つ
export async function savePhotoRecord(page: Page): Promise<void> {
  await page.getByRole("button", { name: "保存する" }).click();
  await page.waitForURL(/\/records\/[0-9a-f-]{36}/, { timeout: 30_000 });
}
