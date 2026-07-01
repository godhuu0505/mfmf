import Link from "next/link";
import Image from "next/image";
import {
  CalendarDays,
  CircleHelp,
  Images,
  LogOut,
  PawPrint,
  Settings,
  Share2,
} from "lucide-react";

// 共通ヘッダー。右側にログアウトボタン。
// アイコンは lucide-react（線画・currentColor 継承）。色はテーマトークンに追従する。
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
            className="text-muted-foreground transition hover:text-foreground"
            aria-label="ギャラリー"
            title="ギャラリー"
          >
            <Images className="h-5 w-5" aria-hidden="true" />
          </Link>
          <Link
            href="/calendar"
            className="text-muted-foreground transition hover:text-foreground"
            aria-label="カレンダー"
            title="カレンダー"
          >
            <CalendarDays className="h-5 w-5" aria-hidden="true" />
          </Link>
          <Link
            href="/pets"
            className="text-muted-foreground transition hover:text-foreground"
            aria-label="ペット"
            title="ペット"
          >
            <PawPrint className="h-5 w-5" aria-hidden="true" />
          </Link>
          <Link
            href="/shares"
            className="text-muted-foreground transition hover:text-foreground"
            aria-label="共有リンク"
            title="共有リンク"
          >
            <Share2 className="h-5 w-5" aria-hidden="true" />
          </Link>
          <Link
            href="/help"
            className="text-muted-foreground transition hover:text-foreground"
            aria-label="ヘルプ"
            title="ヘルプ"
          >
            <CircleHelp className="h-5 w-5" aria-hidden="true" />
          </Link>
          <Link
            href="/settings"
            className="text-muted-foreground transition hover:text-foreground"
            aria-label="設定"
            title="設定"
          >
            <Settings className="h-5 w-5" aria-hidden="true" />
          </Link>
          <form action="/auth/signout" method="post">
            <button
              type="submit"
              className="flex items-center gap-1 text-sm text-muted-foreground transition hover:text-foreground"
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
              ログアウト
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}
