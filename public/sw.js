// mfmf service worker
// 目的: インストール可能化 + 静的アセットの高速化 + オフライン時のフォールバック。
//
// 重要: Supabase の API レスポンスや署名付き写真 URL（private / 期限付き）は
// 一切キャッシュしない。認証状態が絡む情報をブラウザに残さないため、
// ナビゲーションは network-first（オフライン時のみシェルへフォールバック）。

const VERSION = "v1";
const STATIC_CACHE = `mfmf-static-${VERSION}`;
const SHELL_CACHE = `mfmf-shell-${VERSION}`;
const OFFLINE_URL = "/offline";

const PRECACHE = [
  OFFLINE_URL,
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(PRECACHE)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => ![STATIC_CACHE, SHELL_CACHE].includes(k))
          .map((k) => caches.delete(k)),
      ),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // GET 以外（フォーム送信 / Server Action など）は素通し
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // 同一オリジン以外（Supabase ストレージ/API 等）は介入しない
  if (url.origin !== self.location.origin) return;

  // Supabase 認証コールバック等は触らない
  if (url.pathname.startsWith("/auth")) return;

  // ページ遷移: network-first → 失敗時オフラインページ
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => caches.match(OFFLINE_URL)),
    );
    return;
  }

  // 静的アセット（Next のビルド成果物 / アイコン）は stale-while-revalidate
  const isStatic =
    url.pathname.startsWith("/_next/static") ||
    url.pathname.startsWith("/icon-") ||
    url.pathname === "/apple-touch-icon.png" ||
    url.pathname === "/manifest.webmanifest";

  if (isStatic) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        const network = fetch(request)
          .then((res) => {
            if (res && res.status === 200) cache.put(request, res.clone());
            return res;
          })
          .catch(() => cached);
        return cached || network;
      }),
    );
  }
});
