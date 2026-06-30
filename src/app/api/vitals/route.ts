import * as Sentry from "@sentry/nextjs";

// Web Vitals 受け口。クライアント Sentry SDK を入れない方針なので、
// 計測値はここで受けて Sentry に server-side で投げる（DSN 未設定なら no-op）。
// 認証は要求しない（送信元はあくまで自分たちのブラウザ、悪用余地は小さい）。
//
// p75 を Sentry で集計できるよう、captureMessage（値が extra 行きで数値集計
// 不可）ではなく Trace Metrics の distribution として送る。distribution 型は
// 分布を保持するので Sentry 側で metric × path ごとの p75 が出せる。
export async function POST(req: Request) {
  let metric: WebVital | null = null;
  try {
    metric = (await req.json()) as WebVital;
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  if (!metric || typeof metric.name !== "string") {
    return new Response("bad shape", { status: 400 });
  }

  // 値は有限の数値のみ。未認証エンドポイントなので、不正な JSON で
  // distribution に NaN / Infinity / undefined が入らないよう弾く。
  if (typeof metric.value !== "number" || !Number.isFinite(metric.value)) {
    return new Response("bad value", { status: 400 });
  }

  // 受け付ける名前は next/web-vitals が出す既知のものに限定する。未認証なので
  // 任意名で Sentry のメトリクス名（カーディナリティ）が無制限に増えるのを防ぐ。
  // 未知の名前は黙って捨てて 204（telemetry なのでエラーにはしない）。
  if (!ALLOWED_METRICS.has(metric.name)) {
    return new Response(null, { status: 204 });
  }

  // CLS は単位なしのスコア、それ以外（LCP/INP/FCP/TTFB）はミリ秒。
  const unit = metric.name === "CLS" ? "none" : "millisecond";

  Sentry.metrics.distribution(
    `web_vital.${metric.name.toLowerCase()}`,
    metric.value,
    {
      unit,
      // PII は載せない（既存 payload と同じく path / rating / navigation_type のみ）。
      attributes: {
        metric: metric.name,
        rating: metric.rating ?? "unknown",
        path: normalizePath(metric.path),
        navigation_type: metric.navigationType ?? "unknown",
      },
    },
  );

  // メトリクスは 5s デバウンス等でしかフラッシュされず、serverless 関数が
  // 先に凍結すると単発の計測が失われ得る。返却前に明示フラッシュして確実に送る。
  // 送信失敗はアプリ動作（204 応答）を阻害しないよう握り潰す（fire-and-forget）。
  try {
    await Sentry.flush(2000);
  } catch {
    // ignore
  }

  return new Response(null, { status: 204 });
}

type WebVital = {
  name: string;
  value: number;
  rating?: "good" | "needs-improvement" | "poor";
  id?: string;
  navigationType?: string;
  path?: string;
};

// next/web-vitals が報告し得る既知のメトリクス名。Core Web Vitals に加え、
// Next.js のカスタム計測（hydration / render など）も含む。これ以外は受け取らない
// （未認証エンドポイントでの任意名によるメトリクス・カーディナリティ肥大を防ぐ）。
const ALLOWED_METRICS = new Set([
  "CLS",
  "FCP",
  "INP",
  "LCP",
  "TTFB",
  "Next.js-hydration",
  "Next.js-route-change-to-render",
  "Next.js-render",
]);

// p75 は path 属性で group by する。静的ルートはそのまま、動的ルートは
// パターンに畳んで送る（UUID/token ごとに系列が分裂し、かつ未認証経由で
// path のカーディナリティが無制限に増えるのを防ぐ）。未知のパスは "other"。
const KNOWN_PATHS = new Set([
  "/",
  "/login",
  "/records/new",
  "/calendar",
  "/gallery",
  "/pets",
  "/weight",
  "/settings",
  "/shares",
  "/feedback",
  "/offline",
  "/help",
]);

function normalizePath(raw: string | undefined): string {
  if (typeof raw !== "string" || !raw.startsWith("/")) return "other";
  if (KNOWN_PATHS.has(raw)) return raw;
  if (/^\/records\/[^/]+$/.test(raw)) return "/records/[id]";
  if (/^\/share\/[^/]+$/.test(raw)) return "/share/[token]";
  if (raw === "/auth" || raw.startsWith("/auth/")) return "/auth/*";
  return "other";
}
