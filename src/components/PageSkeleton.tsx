// 詳細・サブページ共通の中立的なローディング骨組み。
// ヘッダー風バー + いくつかのブロックで体感速度を上げる。
export default function PageSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">読み込み中</span>
      <div className="safe-pt sticky top-0 z-10 border-b border-slate-200 bg-white/80 backdrop-blur">
        <div className="safe-px mx-auto flex max-w-2xl items-center justify-between py-3">
          <div className="skeleton h-7 w-24 rounded-lg" />
          <div className="skeleton h-5 w-28 rounded-lg" />
        </div>
      </div>
      <main className="mx-auto max-w-2xl px-4 py-6">
        <div className="skeleton mb-4 h-6 w-40 rounded-lg" />
        <div className="space-y-3">
          {Array.from({ length: rows }).map((_, i) => (
            <div
              key={i}
              className="skeleton h-16 w-full rounded-2xl"
            />
          ))}
        </div>
      </main>
    </div>
  );
}
