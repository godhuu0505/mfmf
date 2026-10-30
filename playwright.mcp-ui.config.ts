import { defineConfig, devices } from "@playwright/test";

// This suite renders production client components against fictional API fixtures.
// It has no app login/session/database and never reads an env file.
export default defineConfig({
  testDir: "./tests/mcp-ui",
  testMatch: "**/*.spec.ts",
  outputDir: "test-results/mcp-ui",
  timeout: 20_000,
  expect: { timeout: 5_000 },
  retries: 0,
  workers: 1,
  reporter: [["list"], ["html", { outputFolder: "playwright-report/mcp-ui", open: "never" }]],
  projects: ["light", "dark"].map(colorScheme => ({
    name: `mobile-${colorScheme}`,
    use: { ...devices["Pixel 7"], colorScheme: colorScheme as "light" | "dark" },
  })),
  use: {
    baseURL: "http://127.0.0.1:5191",
    locale: "ja-JP", timezoneId: "Asia/Tokyo", serviceWorkers: "block",
    trace: "retain-on-failure",
    ...(process.env.MFMF_MCP_UI_CHROME_CHANNEL === "chrome" ? { channel: "chrome" } : {}),
  },
  webServer: {
    command: "node tests/mcp-ui/server.mjs",
    url: "http://127.0.0.1:5191",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
