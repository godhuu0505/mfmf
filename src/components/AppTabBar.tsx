"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { CalendarDays, House, Images, Menu, Plus } from "lucide-react";

// ボトムタブバー（D33: 案A・5 スロット・中央に記録ボタン）。
// AppHeader（サーバー側）から世帯所属が確認できたページにだけ描画される。
// viewer は中央ボタンを抜いた 4 列になる（作成導線を出さない = UC-A06）。

type TabDef = {
  href: string;
  label: string;
  icon: typeof House;
  isActive: (pathname: string) => boolean;
};

// メニュータブ配下として扱うパス（アクティブ表示の判定に使う）
const MENU_PATHS = [
  "/menu",
  "/pets",
  "/weight",
  "/settings",
  "/help",
  "/feedback",
  "/shares",
];

const LEFT_TABS: TabDef[] = [
  {
    href: "/",
    label: "ホーム",
    icon: House,
    isActive: (p) => p === "/" || p.startsWith("/records"),
  },
  {
    href: "/calendar",
    label: "カレンダー",
    icon: CalendarDays,
    isActive: (p) => p.startsWith("/calendar"),
  },
];

const RIGHT_TABS: TabDef[] = [
  {
    href: "/gallery",
    label: "アルバム",
    icon: Images,
    isActive: (p) => p.startsWith("/gallery"),
  },
  {
    href: "/menu",
    label: "メニュー",
    icon: Menu,
    isActive: (p) =>
      MENU_PATHS.some((m) => p === m || p.startsWith(`${m}/`)),
  },
];

function TabLink({ tab, pathname }: { tab: TabDef; pathname: string }) {
  const active = tab.isActive(pathname);
  const Icon = tab.icon;
  return (
    <Link
      href={tab.href}
      aria-current={active ? "page" : undefined}
      className={
        "flex flex-col items-center gap-0.5 pb-1.5 pt-2 text-[10px] font-medium transition " +
        (active ? "text-primary" : "text-muted-foreground hover:text-foreground")
      }
    >
      <Icon className="h-6 w-6" aria-hidden="true" />
      {tab.label}
    </Link>
  );
}

export default function AppTabBar({ readOnly }: { readOnly: boolean }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // 記録フォーム（新規 / 編集 ?edit=1）は全画面モーダル扱い（D33）。
  // タブバーを出さない（誤タップで下書きを失わないため）。
  if (pathname === "/records/new") return null;
  if (pathname.startsWith("/records/") && searchParams.get("edit") === "1") {
    return null;
  }

  return (
    <nav
      aria-label="メインナビゲーション"
      data-app-tabbar
      data-quick-record-bg
      className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface/90 pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] backdrop-blur"
    >
      <div
        className={
          "mx-auto grid max-w-2xl " +
          (readOnly ? "grid-cols-4" : "grid-cols-5")
        }
      >
        {LEFT_TABS.map((tab) => (
          <TabLink key={tab.href} tab={tab} pathname={pathname} />
        ))}
        {!readOnly && (
          <button
            type="button"
            onClick={() =>
              window.dispatchEvent(new Event("mfmf:quick-record-open"))
            }
            aria-label="クイック記録"
            aria-haspopup="dialog"
            className="relative"
          >
            <span className="absolute left-1/2 top-0 -mt-5 flex h-14 w-14 -translate-x-1/2 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition hover:bg-primary-hover">
              <Plus className="h-7 w-7" aria-hidden="true" />
            </span>
            <span className="block pb-1.5 pt-9 text-center text-[10px] font-medium text-muted-foreground">
              記録
            </span>
          </button>
        )}
        {RIGHT_TABS.map((tab) => (
          <TabLink key={tab.href} tab={tab} pathname={pathname} />
        ))}
      </div>
    </nav>
  );
}
