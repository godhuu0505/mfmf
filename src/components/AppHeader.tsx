import Link from "next/link";
import Image from "next/image";

// 共通ヘッダー。右側にログアウトボタン。
export default function AppHeader() {
  return (
    <header className="safe-pt sticky top-0 z-10 border-b border-border bg-surface/80 backdrop-blur">
      <div className="safe-px mx-auto flex max-w-2xl items-center justify-between py-3">
        <Link
          href="/"
          className="flex items-center gap-2 text-lg font-bold text-foreground"
        >
          <Image
            src="/icon-192.png"
            alt=""
            width={28}
            height={28}
            className="rounded-lg"
            priority
          />
          mfmf
        </Link>
        <div className="flex items-center gap-4">
          <Link
            href="/gallery"
            className="text-sm text-muted-foreground transition hover:text-foreground"
            aria-label="ギャラリー"
            title="ギャラリー"
          >
            🖼️
          </Link>
          <Link
            href="/calendar"
            className="text-sm text-muted-foreground transition hover:text-foreground"
            aria-label="カレンダー"
            title="カレンダー"
          >
            📅
          </Link>
          <Link
            href="/pets"
            className="text-sm text-muted-foreground transition hover:text-foreground"
            aria-label="ペット"
            title="ペット"
          >
            🐾
          </Link>
          <Link
            href="/shares"
            className="text-sm text-muted-foreground transition hover:text-foreground"
            aria-label="共有リンク"
            title="共有リンク"
          >
            🔗
          </Link>
          <Link
            href="/help"
            className="text-sm text-muted-foreground transition hover:text-foreground"
            aria-label="ヘルプ"
            title="ヘルプ"
          >
            ❓
          </Link>
          <Link
            href="/settings"
            className="text-sm text-muted-foreground transition hover:text-foreground"
            aria-label="設定"
            title="設定"
          >
            ⚙️
          </Link>
          <form action="/auth/signout" method="post">
            <button
              type="submit"
              className="text-sm text-muted-foreground transition hover:text-foreground"
            >
              ログアウト
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}
