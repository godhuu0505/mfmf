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
        path: metric.path ?? "unknown",
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
