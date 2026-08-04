// ルート遷移中のフォールバック表示（一覧のスケルトン）。
// 体感速度を上げるため、実レイアウトに近い骨組みを表示する。
// ヘッダー/タブバーは (app)/layout.tsx が持ち続けるので、ここでは描かない
// （骨組みに含めると遷移中だけヘッダーが二重になる）。
export default function Loading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">読み込み中</span>
      <main id="main" className="mx-auto max-w-2xl px-4 py-6">
        <div className="mb-4 flex items-center justify-between">
          <div className="skeleton h-6 w-28 rounded-lg" />
          <div className="skeleton h-9 w-32 rounded-lg" />
        </div>

        <ul className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <li
              key={i}
              className="flex gap-3 rounded-2xl bg-surface p-3 shadow-sm ring-1 ring-border"
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
