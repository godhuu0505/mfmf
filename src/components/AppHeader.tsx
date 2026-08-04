import Link from "next/link";
import Image from "next/image";
import { createClient } from "@/lib/supabase/server";
import AccountMenu from "@/components/AccountMenu";

// 共通ヘッダー。主要ナビはボトムタブバー（AppTabBar / D33）に移したため、
// ここはロゴとアカウントメニューだけの薄い帯。
// タブバー等のアプリクロームは (app)/layout.tsx が描画する。
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
      <div className="safe-px mx-auto flex h-14 max-w-2xl items-center justify-between">
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
        <AccountMenu
          email={user?.email ?? null}
          displayName={profile?.display_name ?? null}
        />
      </div>
    </header>
  );
}
