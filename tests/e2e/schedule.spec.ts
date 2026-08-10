import { test, expect, type Page } from "@playwright/test";
import { login, quickRecord } from "./helpers";

// 予定と担当（D34 / proto/schedule）の受け入れ条件を E2E にしたもの（D25）。
// 実機合意で確かめたのは「完了すると記録になる」「毎週のルールが薄く入り、
// 違う日だけ上書きできる」「記録を足してもルールの予定は消えない」の 3 本。

/** JST の今日（アプリと同じ基準。CI ランナーは UTC）。 */
function jstToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(
    new Date(),
  );
}

function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/**
 * その日のセルの読み上げ（aria-label）を確かめる。**読み直してから**見る ——
 * シートは Server Action の完了で閉じるが、カレンダーの再描画はそのあとに届く。
 * ここで見たいのは「保存されたか」なので、サーバから引き直した状態で判定する。
 */
async function expectDayLabel(page: Page, date: string, re: RegExp) {
  await page.goto(`/calendar?ym=${date.slice(0, 7)}`);
  await expect(page.locator(`[data-day="${date}"]`)).toHaveAttribute(
    "aria-label",
    re,
  );
}

/** その日のセルを開く。月をまたぐ日付にも対応する。 */
async function openDay(page: Page, date: string) {
  await page.goto(`/calendar?ym=${date.slice(0, 7)}`);
  await page.locator(`[data-day="${date}"]`).click();
  const sheet = page.getByRole("dialog", { name: /の予定$/ });
  await expect(sheet).toBeVisible();
  return sheet;
}

test("UC-P01: 予定を入れるとカレンダーに出る", async ({ page }) => {
  await login(page);
  // 日付は過去にする。未来日の記録を作ると、日付の新しい順の一覧で先頭に居座り、
  // 「いま作った記録が先頭」を前提にしている他の spec を壊す
  const date = addDays(jstToday(), -3);

  const sheet = await openDay(page, date);
  await sheet.getByRole("radio", { name: /病院/ }).click();
  await sheet.getByLabel("ひとことメモ（任意）").fill("ワクチン2回目");
  await sheet.getByRole("button", { name: "予定を保存する" }).click();
  await expect(sheet).not.toBeVisible();

  // 月表示のセルに種類が出る（予定は中抜きの点）
  await expectDayLabel(page, date, /予定1件/);
  await expect(page.locator(`[data-day="${date}"]`)).toContainText("病院");
});

test("UC-P02: 予定を完了すると記録になり、種類と時間を引き継ぐ", async ({
  page,
}) => {
  await login(page);
  const date = addDays(jstToday(), -4);

  let sheet = await openDay(page, date);
  await sheet.getByRole("radio", { name: /サロン/ }).click();
  await sheet.getByLabel("開始時刻").fill("10:00");
  await sheet.getByLabel("終了時刻").fill("16:00");
  await sheet.getByRole("button", { name: "予定を保存する" }).click();
  await expect(sheet).not.toBeVisible();

  // 完了して記録にする（本文だけ足す。種類・時刻はそのまま）
  sheet = await openDay(page, date);
  await sheet.getByLabel("ひとことメモ（任意）").fill("シャンプー");
  await sheet.getByRole("button", { name: "完了して記録にする" }).click();
  await expect(sheet).not.toBeVisible();

  // 完了するとその日の「予定」は無くなり、記録は下の一覧に並ぶ。
  // 選び直すと記録として開ける（種類・時刻が引き継がれている）
  sheet = await openDay(page, date);
  await sheet.getByRole("button", { name: /シャンプー/ }).click();
  await expect(
    sheet.getByRole("button", { name: "変更を保存する" }),
  ).toBeVisible();
  await expect(sheet.getByLabel("開始時刻")).toHaveValue("10:00");
  await expect(sheet.getByLabel("終了時刻")).toHaveValue("16:00");
});

test("UC-P03: 見送りにしても消えず、予定に戻せる", async ({ page }) => {
  await login(page);
  const date = addDays(jstToday(), -5);

  let sheet = await openDay(page, date);
  await sheet.getByRole("radio", { name: /サロン/ }).click();
  await sheet.getByRole("button", { name: "予定を保存する" }).click();
  await expect(sheet).not.toBeVisible();

  sheet = await openDay(page, date);
  await sheet.getByRole("button", { name: "見送り", exact: true }).click();
  await expect(sheet).not.toBeVisible();

  await expectDayLabel(page, date, /見送り1件/);

  // 見送ったあとの日は「これから入れる予定」の下書きで開く（UC-C01）。
  // 戻すときは下の一覧からその行を選ぶ
  sheet = await openDay(page, date);
  await sheet.getByRole("button", { name: /サロン/ }).click();
  await sheet.getByRole("button", { name: "予定に戻す" }).click();
  await expect(sheet).not.toBeVisible();
  await expectDayLabel(page, date, /予定1件/);
});

test("UC-P04: 毎週のルールがカレンダーに入り、記録を足しても消えない", async ({
  page,
}) => {
  await login(page);
  const today = jstToday();
  // 今日と同じ曜日の来週。ルールを作ってもこの週に必ず 1 日出る
  const nextWeek = addDays(today, 7);
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();

  await page.goto("/schedule/rules");
  const labels = ["日", "月", "火", "水", "木", "金", "土"];
  const label = labels[weekday];
  const row = page.locator("li", { has: page.getByText(`${label}曜`) }).first();
  await row.getByLabel(`${label}曜の種類`).selectOption("daycare");
  await row.getByRole("button", { name: `${label}曜を今日から変える` }).click();

  // 来週の同じ曜日に、ルール由来の予定が出る
  await page.goto(`/calendar?ym=${nextWeek.slice(0, 7)}`);
  const cell = page.locator(`[data-day="${nextWeek}"]`);
  await expect(cell).toContainText("保育園");

  // 記録を足してもルール由来の予定は消えない（同じ日に並ぶ）
  const marker = `E2E-rule-${Date.now()}`;
  await quickRecord(page, marker);
  await page.goto(`/calendar?ym=${today.slice(0, 7)}`);
  await expect(page.locator(`[data-day="${today}"]`)).toHaveAttribute(
    "aria-label",
    /予定1件/,
  );
});

test("UC-P05: 書きかけのまま閉じると確認をはさむ", async ({ page }) => {
  await login(page);
  const date = addDays(jstToday(), -6);

  const sheet = await openDay(page, date);
  await sheet.getByLabel("ひとことメモ（任意）").fill("書きかけ");
  await page.keyboard.press("Escape");

  await expect(sheet.getByText("編集をやめますか？")).toBeVisible();
  await sheet.getByRole("button", { name: "編集に戻る" }).click();
  await expect(sheet.getByLabel("ひとことメモ（任意）")).toHaveValue(
    "書きかけ",
  );

  await page.keyboard.press("Escape");
  await sheet.getByRole("button", { name: "やめる" }).click();
  await expect(sheet).not.toBeVisible();
});

test("UC-P06: ホームのきょうカードから完了して記録にできる", async ({
  page,
}) => {
  await login(page);
  const today = jstToday();

  // 今日の予定を 1 件入れる
  const sheet = await openDay(page, today);
  await sheet.getByRole("radio", { name: /おうち/ }).click();
  await sheet.getByRole("button", { name: "予定を保存する" }).click();
  await expect(sheet).not.toBeVisible();

  await page.goto("/");
  const card = page.locator("main > div").first();
  await expect(card).toContainText("きょう");
  await card.getByRole("button", { name: "完了して記録にする" }).click();
  // 送信が終わるとボタンごと消える。終わる前に遷移すると保存が途中で切れる
  await expect(
    card.getByRole("button", { name: "完了して記録にする" }),
  ).toBeHidden();

  // 保存されたかを見たいので、読み直してから確かめる
  await page.goto("/");
  await expect(
    page.locator("main > div").first().getByText("記録ずみ"),
  ).toBeVisible();
});
