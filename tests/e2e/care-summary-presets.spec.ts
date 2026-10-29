import { test, expect, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { assertLocalSupabase } from "../localGuard";
import { E2E_USER } from "./global-setup";
import { login } from "./helpers";

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());
function dateOffset(days: number) {
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const petA = crypto.randomUUID();
const petB = crypto.randomUUID();
const recordIds = Array.from({ length: 3 }, () => crypto.randomUUID());
let supabase: SupabaseClient;

// このspec専用の架空ペット・記録だけを作成・削除する。本番接続は送信前に拒否。
test.beforeAll(async () => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
  const dbUrl = process.env.E2E_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
  assertLocalSupabase(url, dbUrl);
  supabase = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
  const { data: auth, error: authError } = await supabase.auth.signInWithPassword(E2E_USER);
  expect(authError).toBeNull();
  const userId = auth.user!.id;
  const { data: membership, error: memberError } = await supabase.from("household_members")
    .select("household_id").eq("user_id", userId).eq("role", "owner").order("created_at").order("household_id").limit(1).single();
  expect(memberError).toBeNull();
  const householdId = membership!.household_id;
  const { error: petsError } = await supabase.from("pets").insert([
    { id: petA, owner_id: userId, household_id: householdId, name: "期間テスト・むぎ", species: "犬" },
    { id: petB, owner_id: userId, household_id: householdId, name: "期間テスト・そら", species: "猫" },
  ]);
  expect(petsError).toBeNull();
  const base = { owner_id: userId, household_id: householdId, source: "home", author: "テストの家族", status: "done" };
  const { error: recordsError } = await supabase.from("daycare_records").insert([
    { ...base, id: recordIds[0], pet_id: petA, record_date: today, body: "むぎの今日の記録" },
    { ...base, id: recordIds[1], pet_id: petB, record_date: today, body: "そらの今日の記録" },
    { ...base, id: recordIds[2], pet_id: petB, record_date: dateOffset(-20), body: "そらの20日前の記録" },
  ]);
  expect(recordsError).toBeNull();
});

test.afterAll(async () => {
  if (!supabase) return;
  const { error: recordsError } = await supabase.from("daycare_records").delete().in("id", recordIds);
  expect(recordsError).toBeNull();
  const { error: petsError } = await supabase.from("pets").delete().in("id", [petA, petB]);
  expect(petsError).toBeNull();
  await supabase.auth.signOut();
});

async function expectRange(page: Page, petId: string, from: string, to: string) {
  await expect(page).toHaveURL((url) => url.pathname === "/care-summary"
    && url.searchParams.get("pet") === petId && url.searchParams.get("from") === from && url.searchParams.get("to") === to);
  await expect(page.getByRole("combobox", { name: "ペット", exact: true })).toHaveValue(petId);
  await expect(page.getByLabel("開始日", { exact: true })).toHaveValue(from);
  await expect(page.getByLabel("終了日", { exact: true })).toHaveValue(to);
}

test("UC-CSP01: 表示前に変更したペットを7日・30日の期間ボタンでも維持する", async ({ page }) => {
  await login(page);
  for (const days of [7, 30]) {
    await page.goto(`/care-summary?pet=${petA}`);
    await expect(page.getByRole("article", { name: "期間テスト・むぎの引き継ぎシート" })).toBeVisible();
    await page.getByRole("combobox", { name: "ペット", exact: true }).selectOption(petB);
    // 「表示する」を押す前の選択を使う。URLに残るpetAへ戻さない。
    await page.getByRole("button", { name: `直近${days}日＋今後7日`, exact: true }).click();
    await expectRange(page, petB, dateOffset(1 - days), dateOffset(7));
    const sheet = page.getByRole("article", { name: "期間テスト・そらの引き継ぎシート" });
    await expect(sheet).toContainText("そらの今日の記録");
    await expect(sheet).not.toContainText("むぎの今日の記録");
    if (days === 30) await expect(sheet).toContainText("そらの20日前の記録");
    else await expect(sheet).not.toContainText("そらの20日前の記録");
  }
  await page.screenshot({ path: "test-results/screenshots/care-summary-presets.png" });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: "test-results/screenshots/care-summary-presets-dark.png" });
});

test("UC-CSP02: 不正日付から期間ボタンで復帰し、その後の手入力も保持する", async ({ page }) => {
  await login(page);
  await page.goto(`/care-summary?pet=${petA}&from=2026-02-30&to=2026-03-01`);
  await expect(page.getByRole("alert").filter({ hasText: "正しい日付" })).toBeVisible();
  await page.getByRole("combobox", { name: "ペット", exact: true }).selectOption(petB);
  await page.getByRole("button", { name: "直近7日＋今後7日", exact: true }).click();
  await expectRange(page, petB, dateOffset(-6), dateOffset(7));
  await expect(page.getByRole("alert").filter({ hasText: "正しい日付" })).toHaveCount(0);
  await expect(page.getByRole("article", { name: "期間テスト・そらの引き継ぎシート" })).toBeVisible();

  await page.getByLabel("開始日", { exact: true }).fill(dateOffset(-20));
  await page.getByLabel("終了日", { exact: true }).fill(dateOffset(-10));
  await page.getByRole("button", { name: "表示する", exact: true }).click();
  await expectRange(page, petB, dateOffset(-20), dateOffset(-10));
  const sheet = page.getByRole("article", { name: "期間テスト・そらの引き継ぎシート" });
  await expect(sheet).toContainText("そらの20日前の記録");
  await expect(sheet).not.toContainText("そらの今日の記録");
});

test("UC-CSP03: ペット未選択では必須検証を行い、選んだ後は期間を保って表示する", async ({ page }) => {
  await login(page);
  await page.goto("/care-summary?pet=");
  await page.getByRole("button", { name: "直近30日＋今後7日", exact: true }).click();
  await expect(page).toHaveURL(/\/care-summary\?pet=$/);
  const select = page.getByRole("combobox", { name: "ペット", exact: true });
  await expect(select).toBeFocused();
  expect(await select.evaluate((element: HTMLSelectElement) => element.validity.valueMissing)).toBe(true);
  await expect(page.getByLabel("開始日", { exact: true })).toHaveValue(dateOffset(-29));
  await expect(page.getByLabel("終了日", { exact: true })).toHaveValue(dateOffset(7));
  await expect(page.getByRole("article")).toHaveCount(0);

  await select.selectOption(petB);
  await page.getByRole("button", { name: "表示する", exact: true }).click();
  await expectRange(page, petB, dateOffset(-29), dateOffset(7));
  await expect(page.getByRole("article", { name: "期間テスト・そらの引き継ぎシート" })).toContainText("そらの20日前の記録");
});
