"use client";

import { useEffect } from "react";

// /sw.js を登録する。本番ビルドでのみ有効化（dev では HMR と競合するため無効）。
export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // 登録失敗は致命的ではないので握りつぶす
      });
    };

    // 軽いページでは React のマウント前に load が発火し終わっていることがあり、
    // リスナー登録だけだと SW が永遠に登録されない（E2E のオフライン検証で発覚）。
    if (document.readyState === "complete") {
      register();
      return;
    }
    window.addEventListener("load", register);
    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}
