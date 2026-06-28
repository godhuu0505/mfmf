import { withSentryConfig } from "@sentry/nextjs";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
};

// Sentry のビルド時統合。DSN が無くてもラップして問題ないが、source map の
// アップロードは SENTRY_AUTH_TOKEN がある時だけ有効化する。
export default withSentryConfig(nextConfig, {
  silent: !process.env.CI,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  sourcemaps: {
    disable: !process.env.SENTRY_AUTH_TOKEN,
  },
  // 動的な import を Sentry が拾えるようクライアント側のファイル取り込みを広げる。
  widenClientFileUpload: true,
  // public な URL に sourcemap を残さない（公開リポなのでデフォルト挙動を明示）。
  hideSourceMaps: true,
  disableLogger: true,
  // Vercel での Ad-blocker 回避用 tunnel ルートは未使用（必要なら有効化）。
});
