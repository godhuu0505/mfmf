// 詳細・サブページ共通の中立的なローディング骨組み。
// ヘッダー/タブバーは (app)/layout.tsx が持ち続けるので、ここでは描かない
// （骨組みに含めると遷移中だけヘッダーが二重になる）。
export default function PageSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">読み込み中</span>
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
