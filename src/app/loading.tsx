// ルート遷移中のフォールバック表示（一覧のスケルトン）。
// 体感速度を上げるため、実レイアウトに近い骨組みを表示する。
export default function Loading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">読み込み中</span>
      {/* ヘッダー風のバー */}
      <div className="safe-pt sticky top-0 z-10 border-b border-slate-200 bg-white/80 backdrop-blur">
        <div className="safe-px mx-auto flex max-w-2xl items-center justify-between py-3">
          <div className="skeleton h-7 w-24 rounded-lg" />
          <div className="skeleton h-5 w-28 rounded-lg" />
        </div>
      </div>

      <main className="mx-auto max-w-2xl px-4 py-6">
        <div className="mb-4 flex items-center justify-between">
          <div className="skeleton h-6 w-28 rounded-lg" />
          <div className="skeleton h-9 w-32 rounded-lg" />
        </div>

        <ul className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <li
              key={i}
              className="flex gap-3 rounded-2xl bg-white p-3 shadow-sm ring-1 ring-slate-200"
            >
              <div className="skeleton h-20 w-20 shrink-0 rounded-xl" />
              <div className="min-w-0 flex-1 space-y-2 py-1">
                <div className="skeleton h-4 w-20 rounded" />
                <div className="skeleton h-4 w-32 rounded" />
                <div className="skeleton h-3 w-48 rounded" />
              </div>
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}
