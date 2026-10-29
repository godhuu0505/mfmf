import { defineConfig } from "vitest/config";

// Dedicated SQL-only target: no shared Supabase seed/globalSetup and no app server.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/recordRankingBudget.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
