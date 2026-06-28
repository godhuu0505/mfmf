import * as Sentry from "@sentry/nextjs";

// Web Vitals 受け口。クライアント Sentry SDK を入れない方針なので、
// 計測値はここで受けて Sentry に server-side で投げる（DSN 未設定なら no-op）。
// 認証は要求しない（送信元はあくまで自分たちのブラウザ、悪用余地は小さい）。
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

  Sentry.captureMessage(`web-vital ${metric.name}`, {
    level: metric.rating === "poor" ? "warning" : "info",
    tags: {
      metric: metric.name,
      rating: metric.rating ?? "unknown",
      path: metric.path ?? "unknown",
    },
    extra: {
      value: metric.value,
      id: metric.id,
      navigationType: metric.navigationType,
    },
  });

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
