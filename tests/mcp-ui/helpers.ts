import { expect, type Page, type Route } from "@playwright/test";

export const transactionId = "t".repeat(43);
export const csrfToken = "c".repeat(43);
export const householdA = "92000000-0000-4000-8000-000000000001";
export const householdB = "92000000-0000-4000-8000-000000000002";
export const connectionA = "a".repeat(43);
export const connectionB = "b".repeat(43);
export const consent = {
  transactionId, csrfToken, clientName: "ChatGPT", clientId: `mfc_${"f".repeat(43)}`,
  accountLabel: "fictional-parent@example.test",
  eligibleHouseholds: [
    { householdId: householdA, householdName: "架空のたんぽぽ家", role: "owner" },
    { householdId: householdB, householdName: "架空のひまわり家", role: "viewer" },
  ],
};
export const connections = {
  csrfToken,
  connections: [
    { id: connectionA, clientName: "ChatGPT", householdName: "架空のたんぽぽ家", createdAt: "2026-10-30T00:00:01.000Z", expiresAt: "2026-11-29T00:00:01.000Z" },
    { id: connectionB, clientName: "ChatGPT", householdName: "架空のたんぽぽ家", createdAt: "2026-10-30T00:00:02.000Z", expiresAt: "2026-11-29T00:00:02.000Z" },
  ],
};
export const callback = "https://chatgpt.com/connector_platform_oauth_redirect?code=fictional&state=fictional-state&iss=https%3A%2F%2Fmfmf.example.test";
export const approve = (page: Page) => page.getByRole("button", { name: "この家族の記録の閲覧を許可", exact: true });
export const deny = (page: Page) => page.getByRole("button", { name: "許可しない", exact: true });
export async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body), headers: { "cache-control": "private, no-store" } });
}
export async function isolate(page: Page) {
  const blocked: string[] = [];
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin === "http://127.0.0.1:5191") {
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) return route.abort();
      return route.continue();
    }
    blocked.push(url.origin);
    return route.abort();
  });
  return blocked;
}
export async function consentApi(page: Page, response: unknown = consent, status = 200) {
  const writes: Array<{ body: Record<string, unknown>; csrf: string | undefined }> = [];
  await page.route("**/api/oauth/consent?*", route => json(route, response, status));
  await page.route("**/api/oauth/consent", async route => {
    writes.push({ body: route.request().postDataJSON(), csrf: route.request().headers()["x-mfmf-csrf"] });
    await json(route, { redirectTo: callback });
  });
  await page.route("https://chatgpt.com/connector_platform_oauth_redirect?*", route => route.fulfill({ contentType: "text/html", body: "<p>Fictional callback only</p>" }));
  return writes;
}
export async function openConsent(page: Page) {
  await page.goto("/?view=consent");
  await expect(approve(page)).toBeVisible();
}
export async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}
