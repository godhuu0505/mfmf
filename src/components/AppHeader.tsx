import Link from "next/link";
import Image from "next/image";
import { CalendarDays, CircleHelp, Images, PawPrint } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import AccountMenu from "@/components/AccountMenu";

// 共通ヘッダー。右側にアカウントアイコン（押下でメニュー）。
// アイコンは lucide-react（線画・currentColor 継承）。色はテーマトークンに追従する。
export default async function AppHeader() {
  // アバターに表示名/メールの頭文字を出すため、現在のユーザーと表示名を取得する。
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: profile } = user
    ? await supabase
        .from("profiles")
        .select("display_name")
        .eq("owner_id", user.id)
        .maybeSingle()
    : { data: null };

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
        <div className="flex items-center gap-3 sm:gap-4">
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
            href="/help"
            className="text-muted-foreground transition hover:text-foreground"
            aria-label="ヘルプ"
            title="ヘルプ"
          >
            <CircleHelp className="h-5 w-5" aria-hidden="true" />
          </Link>
          <AccountMenu
            email={user?.email ?? null}
            displayName={profile?.display_name ?? null}
          />
        </div>
      </div>
    </header>
  );
}
