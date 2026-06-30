import * as Sentry from "@sentry/nextjs";

// Next.js が Node / Edge ランタイムの両方で起動時に呼ぶフック。
// SENTRY_DSN が未設定なら Sentry.init は no-op になる。
// Trace Metrics（Sentry.metrics.*）は SDK 既定で有効なので明示の opt-in は不要。
// Web Vitals の p75 集計（/api/vitals → distribution）はこれを利用する。
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment:
        process.env.SENTRY_ENVIRONMENT ??
        process.env.VERCEL_ENV ??
        process.env.NODE_ENV,
      // 夫婦運用で量は少ないので tracing は控えめ。必要なら env で上げる。
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
      sendDefaultPii: false,
      debug: false,
    });
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment:
        process.env.SENTRY_ENVIRONMENT ??
        process.env.VERCEL_ENV ??
        process.env.NODE_ENV,
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
      sendDefaultPii: false,
      debug: false,
    });
  }
}

// App Router の Server Component / Route Handler / Server Action で
// 投げられた例外を Sentry が拾えるようにする。
export const onRequestError = Sentry.captureRequestError;
