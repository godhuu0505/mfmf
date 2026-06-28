"use client";

import { useReportWebVitals } from "next/web-vitals";

// 各ナビゲーションで Core Web Vitals (CLS / INP / LCP / FCP / TTFB) を取得し、
// 本番は /api/vitals に sendBeacon、開発は console.log で確認できる。
// クライアント Sentry SDK を入れずに済むよう、サーバ側経由で集約する。
export default function WebVitalsReporter() {
  useReportWebVitals((metric) => {
    if (process.env.NODE_ENV !== "production") {
      console.log(
        `[web-vitals] ${metric.name} ${Math.round(metric.value)} (${metric.rating})`,
        metric,
      );
      return;
    }

    const payload = JSON.stringify({
      name: metric.name,
      value: metric.value,
      rating: metric.rating,
      id: metric.id,
      navigationType: metric.navigationType,
      path: window.location.pathname,
    });

    // sendBeacon が使えるなら優先（ページ離脱時でも確実に送られる）。
    try {
      if (typeof navigator !== "undefined" && navigator.sendBeacon) {
        const blob = new Blob([payload], { type: "application/json" });
        if (navigator.sendBeacon("/api/vitals", blob)) return;
      }
    } catch {
      // fall through to fetch fallback
    }

    void fetch("/api/vitals", {
      body: payload,
      method: "POST",
      keepalive: true,
      headers: { "content-type": "application/json" },
    }).catch(() => {
      // 計測の送信失敗はアプリ動作に影響しないので握り潰す
    });
  });

  return null;
}
