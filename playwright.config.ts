import { defineConfig, devices } from "@playwright/test";

// System 層（D25 / D30 / D31）: next start ＋ ローカル Supabase に対して実行する。
// 前提: `npx supabase start` が済んでいて、以下の env が設定されていること
//   NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY（ローカル値）
// `npm run build` してから `npm run test:e2e`（webServer が next start を起動する）。
const PORT = 3100;

// Service Worker が発行する fetch を Playwright のルーティング/ネットワーク制御の
// 対象にする（既定では SW のリクエストは素通しになり、オフライン遮断が SW に効かない）。
// serviceWorker.spec.ts のオフラインフォールバック検証に必要。
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS ??= "1";

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  timeout: 30_000,
  // 全 spec が同じ E2E ユーザーを共有し「一覧の先頭」を検証するため直列で回す
  // （並列にすると別ファイルの記録作成が先頭カードのアサーションと競合する）
  workers: 1,
  // 記録アプリはスマホ前提（片手・セーフエリア）なのでモバイル画面で回す
  projects: [{ name: "mobile-chromium", use: { ...devices["Pixel 7"] } }],
  expect: {
    // VRT(D31): フォントの AA 差だけを許容する小さな閾値。ベースラインは Linux
    // （CI と同一の chromium ビルド + Noto CJK フォント）で生成してコミットする。
    toHaveScreenshot: { maxDiffPixelRatio: 0.02 },
  },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `npm run start -- -p ${PORT}`,
    url: `http://127.0.0.1:${PORT}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
