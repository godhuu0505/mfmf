import { expect, test } from "@playwright/test";
import { E2E_USER } from "./global-setup";

const transactionId = "t".repeat(43);
const consentPath = `/oauth/consent/${transactionId}`;

test("UC-MCP01: 実ログインを経て同じ確認ページへ戻り、自動で許可しない", async ({ page }) => {
  let mutations = 0;
  await page.route(url => url.pathname === "/api/oauth/consent", async route => {
    if (route.request().method() !== "GET") { mutations++; return route.abort(); }
    return route.fulfill({ json: { transactionId, clientName: "ChatGPT", clientId: "fictional-client", accountLabel: "fictional@example.test", csrfToken: "c".repeat(43), eligibleHouseholds: [{ householdId: "92000000-0000-4000-8000-000000000001", householdName: "架空の家族", role: "viewer" }] } });
  });
  await page.goto(consentPath);
  await expect.poll(() => new URL(page.url()).pathname).toBe("/login");
  expect(new URL(page.url()).searchParams.get("next")).toBe(consentPath);
  await page.getByLabel("メールアドレス").fill(E2E_USER.email);
  await page.getByLabel("パスワード").fill(E2E_USER.password);
  await page.getByRole("button", { name: "メールアドレスでログイン" }).click();
  await page.waitForURL(`**${consentPath}`);
  await expect(page.getByRole("heading", { name: /ChatGPTに/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "この家族の記録の閲覧を許可" })).toBeDisabled();
  expect(mutations).toBe(0);
  const response = await page.request.get(consentPath);
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect(response.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(response.headers()["x-frame-options"]).toBe("DENY");
  expect(response.headers()["referrer-policy"]).toBe("no-referrer");
});

test("UC-MCP01/06: 接続管理も実middlewareで保護し、戻り先を保つ", async ({ page }) => {
  await page.goto("/connections");
  await expect.poll(() => new URL(page.url()).pathname).toBe("/login");
  expect(new URL(page.url()).searchParams.get("next")).toBe("/connections");
  const response = await page.request.get("/connections", { maxRedirects: 0 });
  expect(response.status()).toBe(307);
  expect(new URL(response.headers().location, page.url()).pathname).toBe("/login");
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect(response.headers()["x-frame-options"]).toBe("DENY");
  expect(response.headers()["referrer-policy"]).toBe("no-referrer");
});

test("UC-MCP01/06: 未ログインの確認ページにも機密ページのレスポンス制約がある", async ({ request }) => {
  const response = await request.get(consentPath, { maxRedirects: 0 });
  expect(response.status()).toBe(307);
  const destination = new URL(response.headers().location, response.url());
  expect(destination.pathname).toBe("/login");
  expect(destination.searchParams.get("next")).toBe(consentPath);
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect(response.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(response.headers()["x-frame-options"]).toBe("DENY");
  expect(response.headers()["referrer-policy"]).toBe("no-referrer");
});

test("UC-MCP04/05: セッションなしの接続APIはJSON401を返し、再ログイン先を上書きしない", async ({ request }) => {
  for (const path of [`/api/oauth/consent?transactionId=${transactionId}`, "/api/oauth/connections"]) {
    const response = await request.get(path, { maxRedirects: 0 });
    expect(response.status()).toBe(401);
    expect(response.headers().location).toBeUndefined();
    expect(response.headers()["cache-control"]).toContain("no-store");
    expect(response.headers()["referrer-policy"]).toBe("no-referrer");
    expect(response.headers()["set-cookie"] ?? "").not.toContain("mfmf-post-login-next");
    expect(await response.json()).toMatchObject({ error: "UNAUTHENTICATED" });
  }
});
