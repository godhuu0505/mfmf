import { test, expect, type Page } from "@playwright/test";
import { login } from "./helpers";

// 読み取りだけで週URLの復帰を確認する。新しい予定・記録は作らない。
async function expectWeek(
  page: Page,
  label: string,
  days: number[],
  previous: string,
  next: string,
) {
  await expect(page.getByRole("tab", { name: "週", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText(label, { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "前の週", exact: true })).toHaveAttribute(
    "href", `/calendar?ym=${previous.slice(0, 7)}&w=${previous}&view=week`,
  );
  await expect(page.getByRole("link", { name: "次の週", exact: true })).toHaveAttribute(
    "href", `/calendar?ym=${next.slice(0, 7)}&w=${next}&view=week`,
  );
  // 日付の数字だけでは別の欄と一致するので、曜日と同じ見出しの表示を照合する。
  const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
  for (const [index, weekday] of weekdays.entries()) {
    const dateHeading = new RegExp(`^${weekday}\\s*${days[index]}$`);
    await expect(page.getByText(weekday, { exact: true }).locator("..").filter({ hasText: dateHeading })).toHaveText(dateHeading);
  }
}

test("UC-CWQ01: 実在しない週日付は表示月の1日の週へ戻す", async ({ page }) => {
  await login(page);
  await page.goto("/calendar?ym=2026-02&w=2026-02-30&view=week");
  await expect(page.getByRole("heading", { name: "2026年2月", exact: true })).toBeVisible();
  await expectWeek(page, "2/1 〜 2/7", [1, 2, 3, 4, 5, 6, 7], "2026-01-25", "2026-02-08");
  await page.emulateMedia({ colorScheme: "light" });
  await page.screenshot({ path: "test-results/screenshots/calendar-week-query.png", animations: "disabled" });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: "test-results/screenshots/calendar-week-query-dark.png", animations: "disabled" });
});

test("UC-CWQ02: 存在しない月日を別年の週へ正規化しない", async ({ page }) => {
  await login(page);
  await page.goto("/calendar?ym=2026-02&w=2026-99-99&view=week");
  await expect(page.getByRole("heading", { name: "2026年2月", exact: true })).toBeVisible();
  await expectWeek(page, "2/1 〜 2/7", [1, 2, 3, 4, 5, 6, 7], "2026-01-25", "2026-02-08");
});

test("UC-CWQ03: 実在するうるう日は月をまたぐ正しい週を表示する", async ({ page }) => {
  await login(page);
  await page.goto("/calendar?ym=2024-02&w=2024-02-29&view=week");
  await expect(page.getByRole("heading", { name: "2024年2月", exact: true })).toBeVisible();
  await expectWeek(page, "2/25 〜 3/2", [25, 26, 27, 28, 29, 1, 2], "2024-02-18", "2024-03-03");
});
