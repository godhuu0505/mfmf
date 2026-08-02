import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Integration 層（D30）: Server Action を実 Supabase（ローカルスタック）に対して実行し、
// 「どの認可ヘルパーで・どの世帯を基準に判定したか」を検証する。
// pgTAP（DB が守っているか）からは見えない層で、モック Supabase では
// 呼び間違いがそのまま通ってしまうため実物を使う（V4）。
//
// 前提: `npx supabase start` 済みで NEXT_PUBLIC_SUPABASE_URL /
// NEXT_PUBLIC_SUPABASE_ANON_KEY にローカル値が入っていること。
// CI では db-rls-tests ジョブが pgTAP の後に実行する（起動コストを二重に払わない）。
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    globalSetup: ["tests/integration/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // 実 DB を共有するためテストファイル間の並列実行はしない
    fileParallelism: false,
  },
});
