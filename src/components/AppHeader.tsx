import Link from "next/link";

// 共通ヘッダー。右側にログアウトボタン。
export default function AppHeader() {
  return (
    <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/80 backdrop-blur">
      <div className="mx-auto flex max-w-2xl items-center justify-between px-4 py-3">
        <Link href="/" className="text-lg font-bold text-slate-900">
          mfmf
        </Link>
        <form action="/auth/signout" method="post">
          <button
            type="submit"
            className="text-sm text-slate-500 transition hover:text-slate-800"
          >
            ログアウト
          </button>
        </form>
      </div>
    </header>
  );
}
