import { test, expect } from "@playwright/test";
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

// 専用fixtureはセルフログイン+RLS経由。終了時にこのspecのUUIDだけを消す。
// 通常のE2E setupと同様、本番を指す設定は1リクエストも送る前に拒否する。
const petA = crypto.randomUUID();
const petB = crypto.randomUUID();
const recordIds = Array.from({ length: 6 }, () => crypto.randomUUID());
const ruleId = crypto.randomUUID();
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
    .select("household_id").eq("user_id", userId).eq("role", "owner").order("created_at").order("household_id").limit(1).single();
  expect(memberError).toBeNull();
  const householdId = membership!.household_id;
  const { error: petsError } = await supabase.from("pets").insert([
    { id: petA, owner_id: userId, household_id: householdId, name: "引き継ぎテスト・むぎ", species: "犬" },
    { id: petB, owner_id: userId, household_id: householdId, name: "引き継ぎテスト・そら", species: "猫" },
  ]);
  expect(petsError).toBeNull();
  const base = { owner_id: userId, household_id: householdId, pet_id: petA, source: "home", author: "テストの家族", status: "done" };
  const { error: recordsError } = await supabase.from("daycare_records").insert([
    { ...base, id: recordIds[0], record_date: today, body: "引き継ぎ記録：朝ごはんを完食" },
    { ...base, id: recordIds[1], record_date: dateOffset(-10), body: "期間より前の体重", weight_kg: 4.2 },
    { ...base, id: recordIds[2], record_date: dateOffset(1), source: "clinic", status: "planned", body: "引き継ぎ予定：健診", start_time: "10:00", end_time: "11:00" },
    { ...base, id: recordIds[3], record_date: dateOffset(-1), source: "salon", status: "skipped", body: "引き継ぎ見送り：サロン" },
    { ...base, id: recordIds[4], pet_id: petB, record_date: today, body: "別ペットの記録", weight_kg: 9.9 },
    { ...base, id: recordIds[5], record_date: dateOffset(3), body: "未来の実施済み記録", weight_kg: 99 },
  ]);
  expect(recordsError).toBeNull();
  const { error: assigneeError } = await supabase.from("record_assignees").insert({ record_id: recordIds[2], role: "care", user_id: userId });
  expect(assigneeError).toBeNull();
  // 遠い未来の短い別期間へ置く。ほかのspecが検証する今日の予定には影響しない。
  const ruleDate = dateOffset(50);
  const { error: ruleError } = await supabase.from("schedule_rules").insert({ id: ruleId, household_id: householdId,
    weekday: new Date(`${ruleDate}T00:00:00Z`).getUTCDay(), since: ruleDate, kind: "daycare", start_time: "09:00", end_time: "18:00", created_by: userId });
  expect(ruleError).toBeNull();
});

test.afterAll(async () => {
  if (!supabase) return;
  const results = await Promise.all([
    supabase.from("daycare_records").delete().in("id", recordIds),
    supabase.from("schedule_rules").delete().eq("id", ruleId),
  ]);
  for (const result of results) expect(result.error).toBeNull();
  const { error } = await supabase.from("pets").delete().in("id", [petA, petB]);
  expect(error).toBeNull();
  await supabase.auth.signOut();
});

test("UC-CS01: ペット別に実績・予定・見送りと体重を整理し、印刷には内容だけを残す", async ({ page }) => {
  await login(page);
  await page.goto("/menu");
  await page.getByRole("link", { name: "お世話の引き継ぎ" }).click();
  await page.getByLabel("ペット", { exact: true }).selectOption(petA);
  await page.getByRole("button", { name: "表示する", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`pet=${petA}`));
  const sheet = page.getByRole("article", { name: "引き継ぎテスト・むぎの引き継ぎシート" });
  await expect(sheet).toContainText("4.20 kg");
  await expect(sheet).toContainText("対象期間より前");
  await expect(page.getByRole("region", { name: "これまでの記録", exact: true })).toContainText("引き継ぎ記録：朝ごはんを完食");
  await expect(page.getByRole("region", { name: "これからの予定", exact: true })).toContainText("引き継ぎ予定：健診");
  await expect(page.getByRole("region", { name: "見送った予定", exact: true })).toContainText("引き継ぎ見送り：サロン");
  await expect(page.getByRole("region", { name: "これまでの記録", exact: true })).not.toContainText("引き継ぎ見送り");
  await expect(sheet).not.toContainText("別ペットの記録");
  await expect(sheet).not.toContainText("未来の実施済み記録");
  await page.screenshot({ path: "test-results/screenshots/care-summary.png", fullPage: true });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: "test-results/screenshots/care-summary-dark.png", fullPage: true });
  await page.evaluate(() => { window.print = () => { document.documentElement.dataset.printRequested = "yes"; }; });
  await page.getByRole("button", { name: "印刷・PDF保存" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-print-requested", "yes");
  await page.emulateMedia({ media: "print" });
  await expect(sheet).toBeVisible();
  await expect(page.getByRole("form", { name: "表示条件" })).not.toBeVisible();
  await expect(page.getByRole("navigation", { name: "メインナビゲーション" })).not.toBeVisible();
  await expect(page.getByRole("button", { name: "印刷・PDF保存" })).not.toBeVisible();
  await expect(sheet).toContainText("作成日");
});

test("UC-CS02: 毎週の予定は対象未設定の枠に出し、期間・ペットの不正指定はエラーにする", async ({ page }) => {
  await login(page);
  const ruleDate = dateOffset(50);
  await page.goto(`/care-summary?pet=${petA}&from=${ruleDate}&to=${ruleDate}`);
  await expect(page.getByRole("region", { name: "対象ペット未設定の世帯予定" })).toContainText("毎週の予定ルールから表示");
  await expect(page.getByRole("region", { name: "これからの予定", exact: true })).not.toContainText("毎週の予定ルールから表示");
  await page.goto(`/care-summary?pet=${petA}&from=2026-02-30&to=2026-03-01`);
  await expect(page.getByRole("alert")).toContainText("正しい日付");
  await expect(page.getByRole("button", { name: "印刷・PDF保存" })).not.toBeVisible();
  await page.goto(`/care-summary?pet=${crypto.randomUUID()}`);
  await expect(page.getByRole("alert")).toContainText("この世帯で確認できません");
});

test("UC-CS03: 未ログインでは引き継ぎシートを開けない", async ({ page }) => {
  await page.goto(`/care-summary?pet=${petA}`);
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("article")).toHaveCount(0);
});
