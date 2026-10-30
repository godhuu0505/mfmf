import { test, expect } from "@playwright/test";
import { approve, callback, consent, consentApi, csrfToken, deny, householdB, isolate, json, noOverflow, openConsent, transactionId } from "./helpers";

test("explicit household choice is required; viewer consent carries only that household and CSRF", async ({ page }) => {
  const blocked = await isolate(page); const writes = await consentApi(page);
  await openConsent(page);
  await expect(approve(page)).toBeDisabled();
  await expect(page.getByRole("radio", { checked: true })).toHaveCount(0);
  expect(writes).toHaveLength(0);
  await expect(page.getByText(consent.accountLabel, { exact: true })).toBeVisible();
  await page.getByRole("radio", { name: /架空のひまわり家/ }).check();
  await approve(page).click();
  await expect(page).toHaveURL(callback);
  expect(writes).toEqual([{ body: { transactionId, householdId: householdB, approved: true }, csrf: csrfToken }]);
  expect(blocked).toEqual([]);
});

test("deny is possible without selecting a family and never grants access", async ({ page }) => {
  await isolate(page); const writes = await consentApi(page);
  await openConsent(page); await deny(page).click();
  await expect(page).toHaveURL(callback);
  expect(writes).toEqual([{ body: { transactionId, approved: false }, csrf: csrfToken }]);
});

test("no household cannot approve, but can deny", async ({ page }) => {
  await isolate(page); const writes = await consentApi(page, { ...consent, eligibleHouseholds: [] });
  await openConsent(page); await expect(approve(page)).toBeDisabled();
  await expect(page.getByText("接続できる家族がありません")).toBeVisible();
  await deny(page).click(); await expect(page).toHaveURL(callback);
  expect(writes[0].body).toEqual({ transactionId, approved: false });
});

for (const status of [401, 404, 503]) test(`consent ${status} never offers stale permission`, async ({ page }) => {
  await isolate(page); const writes = await consentApi(page, { error: status === 401 ? "UNAUTHENTICATED" : status === 404 ? "NOT_FOUND" : "MCP_DISABLED" }, status);
  await page.goto("/?view=consent");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(approve(page)).toHaveCount(0);
  if (status === 401) {
    const link = page.getByRole("link", { name: /ログイン/ });
    await expect(link).toHaveAttribute("href", `/login?next=${encodeURIComponent(`/oauth/consent/${transactionId}`)}`);
  }
  expect(writes).toHaveLength(0);
});

test("a login redirect/HTML or malformed context cannot become successful consent", async ({ page }) => {
  const blocked = await isolate(page); const writes = await consentApi(page);
  await page.route("**/api/oauth/consent?*", route => route.fulfill({ status: 302, headers: { location: "/login" } }));
  await page.goto("/?view=consent");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(approve(page)).toHaveCount(0); expect(writes).toHaveLength(0);
  await page.route("**/api/oauth/consent?*", route => json(route, { ...consent, csrfToken: "malformed" }));
  await page.reload(); await expect(page.getByRole("alert")).toBeVisible();
  await expect(approve(page)).toHaveCount(0); expect(blocked).toEqual([]);
});

test("a different transaction response cannot authorize this page", async ({ page }) => {
  await isolate(page); const writes = await consentApi(page, { ...consent, transactionId: "x".repeat(43) });
  await page.goto("/?view=consent"); await expect(page.getByRole("alert")).toBeVisible();
  await expect(approve(page)).toHaveCount(0); expect(writes).toHaveLength(0);
});

test("duplicate consent clicks produce one mutation while pending", async ({ page }) => {
  await isolate(page); await consentApi(page);
  let writes = 0; let finish: (() => void) | undefined;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  await page.route("**/api/oauth/consent", async route => { writes++; await pending; await json(route, { redirectTo: callback }); });
  await openConsent(page); await page.getByRole("radio", { name: /架空のひまわり家/ }).check();
  await approve(page).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect.poll(() => writes).toBe(1);
  await expect(deny(page)).toBeDisabled();
  finish!(); await expect(page).toHaveURL(callback); expect(writes).toBe(1);
});

test("untrusted redirect is blocked after a consent response", async ({ page }) => {
  const blocked = await isolate(page); await consentApi(page);
  await page.route("**/api/oauth/consent", route => json(route, { redirectTo: "https://untrusted.example/collect" }));
  await openConsent(page); await page.getByRole("radio", { name: /架空のひまわり家/ }).check(); await approve(page).click();
  await expect(page.getByRole("alert")).toBeVisible();
  expect(new URL(page.url()).origin).toBe("http://127.0.0.1:5191"); expect(blocked).toEqual([]);
});

test("expired CSRF cannot retry a grant automatically", async ({ page }) => {
  await isolate(page); await consentApi(page); let writes = 0;
  await page.route("**/api/oauth/consent", async route => { writes++; await json(route, { error: "FORBIDDEN" }, 403); });
  await openConsent(page); await page.getByRole("radio", { name: /架空のひまわり家/ }).check(); await approve(page).click();
  await expect(page.getByRole("alert")).toBeVisible();
  expect(writes).toBe(1);
  await expect(page.getByText(/接続できました/)).toHaveCount(0);
});

test("untrusted long family labels render as text without overflow", async ({ page }) => {
  await isolate(page);
  await page.setViewportSize({ width: 360, height: 800 });
  const name = "架空の家族".repeat(12) + '<img src=x onerror="window.hacked=true">';
  await consentApi(page, { ...consent, eligibleHouseholds: [{ ...consent.eligibleHouseholds[0], householdName: name }] });
  await openConsent(page); await expect(page.getByText(name, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => "hacked" in window)).toBe(false); await noOverflow(page);
});
