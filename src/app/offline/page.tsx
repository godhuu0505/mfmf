import Link from "next/link";

// オフライン時に Service Worker が表示するフォールバックページ。
export const dynamic = "force-static";

export default function OfflinePage() {
  return (
    <main id="main" className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
      <div className="text-5xl">🐾</div>
      <h1 className="mt-4 text-xl font-bold text-foreground">
        オフラインです
      </h1>
      <p className="mt-2 max-w-xs text-sm text-muted-foreground">
        インターネットに接続できませんでした。電波の良い場所で、もう一度お試しください。
      </p>
      <Link
        href="/"
        className="mt-6 rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition hover:bg-primary-hover"
      >
        再読み込み
      </Link>
    </main>
  );
}
