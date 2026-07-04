import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import AppHeader from "@/components/AppHeader";

export const dynamic = "force-dynamic";

export const metadata = { title: "共有リンク（廃止）" };

// 匿名共有リンク（share_links）は D4/UC-S01 で廃止。ページは終了案内のみ残す
// （既存ブックマーク・リンク流入の受け皿）。共有は viewer 招待 or ゲスト招待で行う。
export default async function SharesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  return (
    <>
      <AppHeader />
      <main id="main" className="mx-auto max-w-2xl px-4 py-6">
        <div className="mb-4">
          <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
            ← 一覧へ戻る
          </Link>
        </div>
        <h1 className="mb-2 text-xl font-bold text-foreground">
          共有リンクは廃止されました
        </h1>
        <section className="space-y-3 rounded-2xl bg-surface p-5 shadow-sm ring-1 ring-border">
          <p className="text-sm text-foreground">
            URL を知っていれば誰でも閲覧できる匿名の共有リンクは廃止しました。
            発行済みのリンクはすべて無効になっています。
          </p>
          <p className="text-sm text-muted-foreground">
            記録を家族や第三者に見てもらうときは、これからは相手にアカウントで
            参加してもらう形になります:
          </p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-foreground">
            <li>
              祖父母など家族に見せる →{" "}
              <span className="font-medium">viewer として招待</span>
              （閲覧のみ）
            </li>
            <li>
              保育園・シッターに預ける →{" "}
              <span className="font-medium">ゲストとして招待</span>
              （対象ペット・期間を限定）
            </li>
          </ul>
          <Link
            href="/settings"
            className="inline-block rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition hover:bg-primary-hover"
          >
            設定で招待する
          </Link>
        </section>
      </main>
    </>
  );
}
