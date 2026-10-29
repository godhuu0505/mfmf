// Check only the local static prototype with a fresh, unauthenticated browser.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { chromium } from "@playwright/test";

const html = await fs.readFile(new URL("./index.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert(script);
new vm.Script(script);
assert(!/\b(fetch|XMLHttpRequest|WebSocket|localStorage|sessionStorage|serviceWorker)\b/.test(script));
assert(html.includes("connect-src 'none'"));
assert(html.includes("form-action 'none'"));
const output = "/tmp/mfmf-mcp-prototype";
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, colorScheme: "light" });
  const outside = [];
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === "http://127.0.0.1:5187") return route.continue();
    outside.push(url.origin);
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://127.0.0.1:5187/");
  await page.locator("#page-title").waitFor();
  assert((await page.locator("#page-title").textContent()).includes("ChatGPT"));
  const checkWidth = async () => assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "horizontal overflow");
  const capture = (name) => page.screenshot({ path: `${output}/${name}.png`, fullPage: true });
  await page.locator("#theme").selectOption("light");
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--primary").trim()), "#c2410c");
  await checkWidth();
  await capture("consent-mobile-light");
  await page.locator("#theme").selectOption("dark");
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--primary").trim()), "#fb923c");
  await capture("consent-mobile-dark");
  await page.locator("#theme").selectOption("light");
  await page.getByRole("radio").nth(1).check();
  await page.getByText("AIへ渡る記録の例を見る").click();
  assert((await page.locator("#preview-title").textContent()).includes("ナギ"));
  await page.locator("#approve").click();
  assert((await page.locator("#screen").textContent()).includes("そよかぜ家"));
  await page.locator("#manage").click();
  const before = await page.locator("[data-revoke]").count();
  await page.locator("[data-revoke]").first().click();
  assert.equal(await page.locator("[data-revoke]").count(), before - 1);
  assert((await page.locator("#announcement").textContent()).includes("そよかぜ家"));
  await page.locator("#scenario").selectOption("empty");
  assert((await page.locator("#screen").textContent()).includes("接続中のAIサービスはありません"));
  await page.locator("#scenario").selectOption("duplicates");
  await checkWidth();
  await capture("connections-mobile-light");
  await page.locator("#theme").selectOption("dark");
  await capture("connections-mobile-dark");
  await page.locator("#consent-tab").click();
  await page.locator("#scenario").selectOption("no-household");
  assert(await page.locator("#approve").isDisabled());
  assert.equal(await page.locator("#preview-title").count(), 0);
  await page.locator("#scenario").selectOption("expired");
  assert.equal(await page.locator("#approve").count(), 0);
  await page.locator("#scenario").selectOption("long");
  for (const width of [360, 390, 430, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await checkWidth();
  }
  await page.locator("#theme").selectOption("light");
  await capture("consent-desktop-light");
  await page.setViewportSize({ width: 390, height: 844 });
  await capture("consent-mobile-long-name");
  await page.locator("#provider").selectOption("Claude");
  await page.locator("#deny").click();
  assert((await page.locator("#page-title").textContent()).includes("接続を取り消しました"));
  assert.equal(outside.length, 0);
  assert.deepEqual(errors, []);
  process.stdout.write(JSON.stringify({ checks: "passed", viewports: [360, 390, 430, 1280], themes: ["light", "dark"], externalRequests: 0, browserErrors: 0, screenshots: output }) + "\n");
} finally {
  await browser.close();
}
