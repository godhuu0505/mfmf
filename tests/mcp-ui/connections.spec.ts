import { test, expect } from "@playwright/test";
import { connectionA, connectionB, connections, csrfToken, isolate, json, noOverflow } from "./helpers";

test("same client and household rows revoke only the selected stable connection", async ({ page }) => {
  await isolate(page); const writes: unknown[] = [];
  await page.route("**/api/oauth/connections", async route => {
    if (route.request().method() === "GET") return json(route, { ...connections, connections: [...connections.connections].reverse() });
    writes.push({ body: route.request().postDataJSON(), csrf: route.request().headers()["x-mfmf-csrf"] });
    await json(route, { revoked: true });
  });
  await page.goto("/?view=connections");
  const rows = page.getByRole("article");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText(/0?9:00:02/); await expect(rows.nth(1)).toContainText(/0?9:00:01/);
  await rows.nth(0).getByRole("button", { name: /接続を解除/ }).click();
  await expect(rows).toHaveCount(1); await expect(rows.first()).toContainText(/0?9:00:01/);
  expect(writes).toEqual([{ body: { id: connectionB }, csrf: csrfToken }]);
  await rows.first().getByRole("button", { name: /接続を解除/ }).click();
  await expect(page.getByText("接続中のAIサービスはありません")).toBeVisible();
  expect(writes[1]).toEqual({ body: { id: connectionA }, csrf: csrfToken });
});

test("failed revoke preserves the connection and never claims success", async ({ page }) => {
  await isolate(page); let writes = 0;
  await page.route("**/api/oauth/connections", async route => {
    if (route.request().method() === "GET") return json(route, connections);
    writes++; return json(route, { error: "FORBIDDEN" }, 403);
  });
  await page.goto("/?view=connections");
  await page.getByRole("article").first().getByRole("button", { name: /接続を解除/ }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByText(/接続を解除しました/)).toHaveCount(0);
  await expect(page.getByRole("article")).toHaveCount(2);
  expect(writes).toBe(1);
});

test("malformed revoke response cannot remove a connection", async ({ page }) => {
  await isolate(page);
  await page.route("**/api/oauth/connections", route => json(route, route.request().method() === "GET" ? connections : { revoked: false }));
  await page.goto("/?view=connections");
  await page.getByRole("article").first().getByRole("button", { name: /接続を解除/ }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByText(/接続を解除しました/)).toHaveCount(0);
  await expect(page.getByRole("article")).toHaveCount(2);
});

test("a pending revoke cannot be submitted twice", async ({ page }) => {
  await isolate(page); let writes = 0; let finish: (() => void) | undefined;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  await page.route("**/api/oauth/connections", async route => {
    if (route.request().method() === "GET") return json(route, connections);
    writes++; await pending; return json(route, { revoked: true });
  });
  await page.goto("/?view=connections");
  await page.getByRole("article").first().getByRole("button", { name: /接続を解除/ }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect.poll(() => writes).toBe(1); finish!(); await expect(page.getByRole("article")).toHaveCount(1); expect(writes).toBe(1);
});

test("expired session offers only the connections login return", async ({ page }) => {
  await isolate(page); await page.route("**/api/oauth/connections", route => json(route, { error: "UNAUTHENTICATED" }, 401));
  await page.goto("/?view=connections"); await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("link", { name: /ログイン/ })).toHaveAttribute("href", "/login?next=%2Fconnections");
  await expect(page.getByRole("article")).toHaveCount(0);
});

test("retry session expiry clears stale rows; a fresh view uses its new CSRF and reordered IDs", async ({ page }) => {
  await isolate(page); let reads = 0;
  const freshCsrf = "n".repeat(43);
  const writes: Array<{ body: unknown; csrf: string | undefined }> = [];
  await page.route("**/api/oauth/connections", async route => {
    if (route.request().method() === "GET") {
      reads++;
      if (reads === 2) return json(route, { error: "UNAUTHENTICATED" }, 401);
      return json(route, reads === 1 ? connections : { csrfToken: freshCsrf, connections: [...connections.connections].reverse() });
    }
    writes.push({ body: route.request().postDataJSON(), csrf: route.request().headers()["x-mfmf-csrf"] });
    return writes.length === 1 ? json(route, { error: "FORBIDDEN" }, 403) : json(route, { revoked: true });
  });
  await page.goto("/?view=connections");
  await page.getByRole("article").first().getByRole("button", { name: /接続を解除/ }).click();
  await expect(page.getByRole("article")).toHaveCount(2);
  await page.getByRole("button", { name: "もう一度確認する" }).click();
  await expect(page.getByRole("link", { name: /ログイン/ })).toHaveAttribute("href", "/login?next=%2Fconnections");
  await expect(page.getByRole("article")).toHaveCount(0);
  expect(writes).toEqual([{ body: { id: connectionA }, csrf: csrfToken }]);
  await page.reload();
  await expect(page.getByRole("article")).toHaveCount(2);
  expect(writes).toHaveLength(1);
  await page.getByRole("article").first().getByRole("button", { name: /接続を解除/ }).click();
  await expect(page.getByRole("article")).toHaveCount(1);
  expect(writes[1]).toEqual({ body: { id: connectionB }, csrf: freshCsrf });
});

test("no connections state and phone width stay readable", async ({ page }) => {
  await isolate(page); await page.route("**/api/oauth/connections", route => json(route, { ...connections, connections: [] }));
  await page.goto("/?view=connections"); await expect(page.getByText("接続中のAIサービスはありません")).toBeVisible();
  await noOverflow(page);
});
