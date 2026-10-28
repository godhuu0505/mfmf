import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { assertLocalSupabase } from "../localGuard";
import { E2E_USER } from "./global-setup";
import { login } from "./helpers";

// 月をまたぐ同じ週。今日の一覧や毎週のルールに影響させないよう、過去に置く。
const weekUrl = "/calendar?ym=2001-01&w=2001-01-31&view=week";
const emptyDay = "2001-01-31";
const nextMonthEmptyDay = "2001-02-02";
const plannedDay = "2001-02-01";
const recordId = crypto.randomUUID();
const planId = crypto.randomUUID();
const planBody = "週表示テスト：診察へ";
let supabase: SupabaseClient;

test.beforeAll(async () => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
  const dbUrl = process.env.E2E_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
  assertLocalSupabase(url, dbUrl);
  supabase = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
  const { data: auth, error: authError } = await supabase.auth.signInWithPassword(E2E_USER);
  expect(authError).toBeNull();
  const userId = auth.user!.id;
  const { data: membership, error: memberError } = await supabase.from("household_members")
    .select("household_id").eq("user_id", userId).eq("role", "owner")
    .order("created_at").order("household_id").limit(1).single();
  expect(memberError).toBeNull();
  // 本番と同じログイン・RLS経由で、このspec専用のUUIDだけを用意する。
  // 記録を先頭に置いても、日付ボタンは既存の「予定」を選ばなければならない。
  const base = { owner_id: userId, household_id: membership!.household_id,
    record_date: plannedDay, author: "テストの家族", overrides_rule: false };
  const { error } = await supabase.from("daycare_records").insert([
    { ...base, id: recordId, source: "home", status: "done", body: "週表示テスト：朝ごはんの記録" },
    { ...base, id: planId, source: "clinic", status: "planned", body: planBody,
      start_time: "10:00", end_time: "11:00" },
  ]);
  expect(error).toBeNull();
});

test.afterAll(async () => {
  if (!supabase) return;
  const { error } = await supabase.from("daycare_records").delete().in("id", [recordId, planId]);
  expect(error).toBeNull();
  await supabase.auth.signOut();
});

test("UC-CW01: 週表示の空の日付から予定入力を開き、閉じると日付に戻る", async ({ page }) => {
  await login(page);
  await page.goto(weekUrl);
  const day = page.locator(`button[data-day="${emptyDay}"]`);
  await expect(day).toHaveAttribute("aria-label", /1月31日.*予定なし/);
  await day.click();
  const sheet = page.getByRole("dialog", { name: /1月31日.*の予定$/ });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('input[name="record_date"]')).toHaveValue(emptyDay);
  await expect(sheet.locator('input[name="record_id"]')).toHaveValue("");
  await expect(sheet.getByRole("button", { name: "予定を保存する", exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/screenshots/calendar-week-empty-day.png", fullPage: true });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: "test-results/screenshots/calendar-week-empty-day-dark.png", fullPage: true });
  await page.emulateMedia({ colorScheme: "light" });
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(day).toBeFocused();
  await expect(page.getByRole("tab", { name: "週", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(new RegExp(`${weekUrl.replaceAll("?", "\\?")}$`));
  await page.screenshot({ path: "test-results/screenshots/calendar-week-day-entry.png", fullPage: true });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: "test-results/screenshots/calendar-week-day-entry-dark.png", fullPage: true });
});

test("UC-CW02: 月をまたぐ週の日付をEnterとSpaceで開ける", async ({ page }) => {
  await login(page);
  await page.goto(weekUrl);
  await expect(page.getByRole("heading", { name: "2001年1月", exact: true })).toBeVisible();
  const day = page.locator(`button[data-day="${nextMonthEmptyDay}"]`);
  await expect(day).toHaveAttribute("aria-label", /2月2日.*予定なし/);
  await day.focus();
  await page.keyboard.press("Enter");
  const sheet = page.getByRole("dialog", { name: /2月2日.*の予定$/ });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('input[name="record_date"]')).toHaveValue(nextMonthEmptyDay);
  await expect(sheet.locator('input[name="record_id"]')).toHaveValue("");
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(day).toBeFocused();
  await page.keyboard.press("Space");
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "閉じる", exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect(day).toBeFocused();
});

test("UC-CW03: 既存の記録がある日も予定を選び、空の入力に置き換えない", async ({ page }) => {
  await login(page);
  await page.goto(weekUrl);
  const day = page.locator(`button[data-day="${plannedDay}"]`);
  await expect(day).toHaveAttribute("aria-label", /予定1件、記録1件/);
  await day.click();
  const sheet = page.getByRole("dialog", { name: /2月1日.*の予定$/ });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('input[name="record_date"]')).toHaveValue(plannedDay);
  await expect(sheet.locator('input[name="record_id"]')).toHaveValue(planId);
  await expect(sheet.getByLabel("ひとことメモ（任意）")).toHaveValue(planBody);
  await expect(sheet.getByLabel("開始時刻")).toHaveValue("10:00");
  await expect(sheet.getByLabel("終了時刻")).toHaveValue("11:00");
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(day).toBeFocused();
});
