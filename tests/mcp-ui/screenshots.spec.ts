import { test, expect } from "@playwright/test";
import { approve, consentApi, connections, isolate, json, noOverflow, openConsent } from "./helpers";

test("production consent and connections components in fictional mobile fixtures", async ({ page }, testInfo) => {
  const blocked = await isolate(page); const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.name));
  await consentApi(page);
  await openConsent(page);
  await page.getByRole("radio", { name: /架空のひまわり家/ }).check();
  await expect(approve(page)).toBeEnabled();
  await expect(approve(page)).toHaveCSS("opacity", "1");
  await page.evaluate(async () => { await document.fonts.ready; });
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
  await noOverflow(page);
  const theme = testInfo.project.name.endsWith("dark") ? "dark" : "light";
  await page.screenshot({ path: `test-results/screenshots/mcp-consent-${theme}.png`, fullPage: true, animations: "disabled" });
  await page.route("**/api/oauth/connections", route => json(route, connections));
  await page.goto("/?view=connections"); await expect(page.getByRole("article")).toHaveCount(2);
  await page.evaluate(async () => { await document.fonts.ready; });
  await noOverflow(page);
  await page.screenshot({ path: `test-results/screenshots/mcp-connections-${theme}.png`, fullPage: true, animations: "disabled" });
  expect(blocked).toEqual([]); expect(errors).toEqual([]);
});
