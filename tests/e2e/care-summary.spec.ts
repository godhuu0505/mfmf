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

// 専用fixtureはセルフログイン+RLS経由。終了時にこのspecのUUIDだけを消す。
// 通常のE2E setupと同様、本番を指す設定は1リクエストも送る前に拒否する。
const petA = crypto.randomUUID();
const petB = crypto.randomUUID();
const recordIds = Array.from({ length: 8 }, () => crypto.randomUUID());
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
    { ...base, id: recordIds[6], record_date: dateOffset(-1), status: "planned", body: "引き継ぎ未完了：お世話" },
    { ...base, id: recordIds[7], pet_id: null, record_date: today, body: "対象未設定の記録本文" },
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
  await expect(page.getByRole("button", { name: "テキストをコピー" })).not.toBeVisible();
  await page.getByRole("combobox", { name: "ペット", exact: true }).selectOption(petA);
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
  // OSのクリップボードには触れず、クリックするまで書き込みがないことも検証する。
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (text: string) => { document.documentElement.dataset.copiedSummary = text; },
    } });
  });
  await expect(page.locator("html")).not.toHaveAttribute("data-copied-summary");
  await page.getByRole("button", { name: "テキストをコピー" }).click();
  await expect(page.getByRole("status")).toContainText("コピーしました。");
  const copied = await page.locator("html").getAttribute("data-copied-summary");
  expect(copied).toContain("お世話の引き継ぎ：引き継ぎテスト・むぎ（犬）");
  expect(copied).toContain(`作成日：${today.replace(/-/g, "/")}（日本時間）`);
  expect(copied).toContain(`${dateOffset(-10).replace(/-/g, "/")}の記録（対象期間より前）`);
  expect(copied).toContain("最近の体重：4.20 kg");
  expect(copied).toContain("引き継ぎ記録：朝ごはんを完食");
  expect(copied).toContain("引き継ぎ予定：健診");
  expect(copied).toContain("引き継ぎ見送り：サロン");
  expect(copied).toContain("引き継ぎ未完了：お世話");
  expect(copied).toContain("対象ペットが未設定の記録");
  expect(copied).not.toContain("別ペットの記録");
  expect(copied).not.toContain("未来の実施済み記録");
  expect(copied).not.toContain("対象未設定の記録本文");
  expect(copied).not.toContain(petA);
  expect(copied).not.toContain(E2E_USER.email);
  // コピー結果は実際のスマホの表示範囲でも残す（固定ナビが重ならない）。
  await page.screenshot({ path: "test-results/screenshots/care-summary-copy.png", animations: "disabled" });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: "test-results/screenshots/care-summary-copy-dark.png", animations: "disabled" });
  await page.emulateMedia({ colorScheme: "light" });
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({ path: "test-results/screenshots/care-summary.png", fullPage: true, animations: "disabled" });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: "test-results/screenshots/care-summary-dark.png", fullPage: true, animations: "disabled" });
  await page.evaluate(() => { window.print = () => { document.documentElement.dataset.printRequested = "yes"; }; });
  await page.getByRole("button", { name: "印刷・PDF保存" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-print-requested", "yes");
  await page.emulateMedia({ media: "print" });
  await expect(sheet).toBeVisible();
  await expect(page.getByRole("form", { name: "表示条件" })).not.toBeVisible();
  await expect(page.getByRole("navigation", { name: "メインナビゲーション" })).not.toBeVisible();
  await expect(page.getByRole("button", { name: "印刷・PDF保存" })).not.toBeVisible();
  await expect(page.getByRole("button", { name: "テキストをコピー" })).not.toBeVisible();
  await expect(sheet).toContainText("作成日");
});

test("UC-CS02: 毎週の予定は対象未設定の枠に出し、期間・ペットの不正指定はエラーにする", async ({ page }) => {
  await login(page);
  const ruleDate = dateOffset(50);
  await page.goto(`/care-summary?pet=${petA}&from=${ruleDate}&to=${ruleDate}`);
  await expect(page.getByRole("region", { name: "対象ペット未設定の世帯予定" })).toContainText("毎週の予定ルールから表示");
  await expect(page.getByRole("region", { name: "これからの予定", exact: true })).not.toContainText("毎週の予定ルールから表示");
  await page.goto(`/care-summary?pet=${petA}&from=2026-02-30&to=2026-03-01`);
  await expect(page.getByRole("alert").filter({ hasText: "正しい日付" })).toBeVisible();
  await expect(page.getByRole("button", { name: "印刷・PDF保存" })).not.toBeVisible();
  await expect(page.getByRole("button", { name: "テキストをコピー" })).not.toBeVisible();
  await page.goto(`/care-summary?pet=${crypto.randomUUID()}`);
  await expect(page.getByRole("alert").filter({ hasText: "この世帯で確認できません" })).toBeVisible();
  await expect(page.getByRole("button", { name: "テキストをコピー" })).not.toBeVisible();
});

test("UC-CS03: 未ログインでは引き継ぎシートを開けない", async ({ page }) => {
  await page.goto(`/care-summary?pet=${petA}`);
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("article")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "テキストをコピー" })).not.toBeVisible();
});

test("UC-CS04: コピーが拒否・非対応でも成功と表示せず、印刷を利用できる", async ({ page }) => {
  await login(page);
  await page.goto(`/care-summary?pet=${petA}`);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async () => { throw new DOMException("Denied", "NotAllowedError"); },
    } });
  });
  await page.getByRole("button", { name: "テキストをコピー" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "コピーできませんでした" })).toBeVisible();
  await expect(page.getByText("コピーしました。", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "印刷・PDF保存" })).toBeEnabled();
  await page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined }); });
  await page.getByRole("button", { name: "テキストをコピー" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "印刷・PDF保存をご利用ください" })).toBeVisible();
  await expect(page.getByRole("button", { name: "テキストをコピー" })).toBeEnabled();
});

/** 最初のOS書き込みを保留する。実クリップボードも本番APIも使わない。 */
async function pendingClipboard(page: Page, outcome: "resolve" | "reject") {
  await page.evaluate((settlement) => {
    let calls = 0;
    document.documentElement.dataset.careCopyDocument = "original";
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: (text: string) => {
        calls += 1;
        document.documentElement.dataset.careCopyCount = String(calls);
        if (calls === 1) return new Promise<void>((resolve, reject) => {
          Object.assign(window, { settleCareSummaryCopy: () => {
            if (settlement === "reject") reject(new DOMException("Denied", "NotAllowedError"));
            else {
              document.documentElement.dataset.careCopiedText = text;
              resolve();
            }
          } });
        });
        document.documentElement.dataset.careCopiedText = text;
        return Promise.resolve();
      },
    } });
  }, outcome);
}

for (const outcome of ["resolve", "reject"] as const) {
  test(`UC-CS05-${outcome}: 期間変更後に旧本文の結果を出さず、同じ文書ではコピーを排他する`, async ({ page }) => {
    await login(page);
    await page.goto(`/care-summary?pet=${petA}`);
    await pendingClipboard(page, outcome);
    await page.getByRole("button", { name: "テキストをコピー" }).click();
    await expect(page.getByRole("button", { name: "コピー中…" })).toBeDisabled();
    await expect(page.locator("html")).toHaveAttribute("data-care-copy-count", "1");

    // 実際の期間操作を使う。Linkは同文書の遷移、期間フォームのボタンはnative GET。
    const shortcut = page.getByRole("link", { name: "直近30日＋今後7日", exact: true })
      .or(page.getByRole("button", { name: "直近30日＋今後7日", exact: true }));
    await shortcut.click();
    await expect(page).toHaveURL((url) => url.searchParams.get("from") === dateOffset(-29));
    await expect(page.getByLabel("開始日", { exact: true })).toHaveValue(dateOffset(-29));
    const clientNavigation = await page.locator("html").getAttribute("data-care-copy-document") === "original";
    if (clientNavigation) {
      await expect(page.locator("html")).toHaveAttribute("data-care-copy-document", "original");
      await expect(page.getByRole("button", { name: "コピー中…" })).toBeDisabled();
      await expect(page.getByRole("button", { name: "テキストをコピー" })).toHaveCount(0);
      await expect(page.locator("html")).toHaveAttribute("data-care-copy-count", "1");
      await page.evaluate(() => {
        (window as unknown as { settleCareSummaryCopy: () => void }).settleCareSummaryCopy();
      });
    } else {
      // PR182の期間ボタンと統合後は旧documentごと破棄される。新しい文書の状態を確認する。
      await expect(page.locator("html")).not.toHaveAttribute("data-care-copy-document");
      await page.evaluate(() => {
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
          writeText: async (text: string) => {
            document.documentElement.dataset.careCopyCount = "1";
            document.documentElement.dataset.careCopiedText = text;
          },
        } });
      });
    }
    await expect(page.getByRole("button", { name: "テキストをコピー" })).toBeEnabled();
    await expect(page.getByText("コピーしました。", { exact: false })).toHaveCount(0);
    await expect(page.getByText("コピーできませんでした。", { exact: false })).toHaveCount(0);
    await page.getByRole("button", { name: "テキストをコピー" }).click();
    await expect(page.getByRole("status")).toContainText("コピーしました。");
    await expect(page.locator("html")).toHaveAttribute("data-care-copy-count", clientNavigation ? "2" : "1");
    const copied = await page.locator("html").getAttribute("data-care-copied-text");
    expect(copied).toContain(`対象期間：${dateOffset(-29).replace(/-/g, "/")}〜${dateOffset(7).replace(/-/g, "/")}`);
  });
}

test("UC-CS06: ペット変更のGET送信では文書が切り替わり、旧コピー状態を引き継がない", async ({ page }) => {
  await login(page);
  await page.goto(`/care-summary?pet=${petA}`);
  await pendingClipboard(page, "resolve");
  await page.getByRole("button", { name: "テキストをコピー" }).click();
  await expect(page.getByRole("button", { name: "コピー中…" })).toBeDisabled();
  await page.getByRole("combobox", { name: "ペット", exact: true }).selectOption(petB);
  await page.getByRole("button", { name: "表示する", exact: true }).click();
  await expect(page.getByRole("article", { name: "引き継ぎテスト・そらの引き継ぎシート" })).toBeVisible();
  // native GETは旧documentごと破棄する。OSの保留操作がキャンセルされたとは主張しない。
  await expect(page.locator("html")).not.toHaveAttribute("data-care-copy-document");
  await expect(page.getByRole("button", { name: "テキストをコピー" })).toBeEnabled();
  await expect(page.getByText("コピーしました。", { exact: false })).toHaveCount(0);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (text: string) => { document.documentElement.dataset.careCopiedText = text; },
    } });
  });
  await page.getByRole("button", { name: "テキストをコピー" }).click();
  await expect(page.getByRole("status")).toContainText("コピーしました。");
  const copied = await page.locator("html").getAttribute("data-care-copied-text");
  expect(copied).toContain("お世話の引き継ぎ：引き継ぎテスト・そら（猫）");
  expect(copied).not.toContain("引き継ぎ記録：朝ごはんを完食");
});
