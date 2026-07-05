import Link from "next/link";
import { Lock } from "lucide-react";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "共有リンクは終了しました",
  // 共有ページは検索エンジンにインデックスさせない。
  robots: { index: false, follow: false },
};

// 匿名共有リンク（share_links / get_shared_view）は D4/UC-S01 で廃止し、テーブルも
// 物理削除済み（Issue #117 §1）。旧トークンで訪れた人の受け皿として、終了案内のみを
// 認証不要で表示する（DB には一切アクセスしない）。共有は viewer 招待 or ゲスト招待へ。
export default async function SharePage() {
  return (
    <main id="main" className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm text-center">
        <p className="mb-2 flex justify-center text-muted-foreground">
          <Lock className="h-10 w-10" aria-hidden="true" />
        </p>
        <h1 className="mb-1 text-lg font-bold text-foreground">
          この共有リンクは終了しました
        </h1>
        <p className="text-sm text-muted-foreground">
          URL を知っていれば誰でも閲覧できる匿名の共有リンクは廃止されました。
          <br />
          これからは、記録を見せたい相手にアカウントで参加してもらう形になります。
          共有した人に、あらためて招待をお願いしてください。
        </p>
        <Link
          href="/login"
          className="mt-5 inline-block rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition hover:bg-primary-hover"
        >
          ログインへ
        </Link>
      </div>
    </main>
  );
}
