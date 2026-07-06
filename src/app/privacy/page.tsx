import Link from "next/link";

export const metadata = { title: "プライバシーポリシー" };

// プライバシーポリシー（下書き・雛形）。
// 正式な文言・同意台帳の整備は #50（法務）で行う。本ページは骨子を用意する足場であり、
// 確定した法務文言ではない。公開（SIGNUP_ENABLED 開放）前に法務レビューを経て確定させること。
const LAST_UPDATED = "2026-07-06";

const sectionClass = "space-y-2";
const h2Class = "text-lg font-bold text-foreground";
const pClass = "text-sm leading-relaxed text-foreground";
const ulClass = "list-disc space-y-1 pl-5 text-sm leading-relaxed text-foreground";

export default function PrivacyPage() {
  return (
    <main id="main" className="mx-auto max-w-2xl px-4 py-10">
      <div className="mb-4">
        <Link
          href="/signup"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← 戻る
        </Link>
      </div>

      <h1 className="mb-1 text-2xl font-bold text-foreground">
        プライバシーポリシー
      </h1>
      <p className="mb-6 text-xs text-muted-foreground">最終更新日: {LAST_UPDATED}</p>

      {/* 下書きであることを明示するバナー（確定文言ではない）。 */}
      <div className="mb-8 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200">
        <p className="font-semibold">これは下書きです</p>
        <p className="mt-1 leading-relaxed">
          本ポリシーは現在整備中の下書きであり、正式な最終版ではありません。正式版は
          一般公開の前に確定・掲載します。
        </p>
      </div>

      <div className="space-y-6">
        <section className={sectionClass}>
          <h2 className={h2Class}>1. 取得する情報</h2>
          <ul className={ulClass}>
            <li>アカウント情報（メールアドレス等の認証情報）</li>
            <li>利用者が登録する記録・写真などのコンテンツ</li>
            <li>
              サービス改善のための技術情報（アクセス状況・エラー情報など。個人を特定
              する情報は最小限に留めます）
            </li>
          </ul>
        </section>

        <section className={sectionClass}>
          <h2 className={h2Class}>2. 利用目的</h2>
          <ul className={ulClass}>
            <li>本サービスの提供・維持・改善のため</li>
            <li>本人確認・認証・不正利用の防止のため</li>
            <li>お問い合わせへの対応のため</li>
          </ul>
        </section>

        <section className={sectionClass}>
          <h2 className={h2Class}>3. 第三者提供</h2>
          <p className={pClass}>
            運営者は、法令に基づく場合を除き、利用者の同意なく個人情報を第三者に提供
            しません。本サービスの運営に必要な範囲で、認証・データ保存・配信などの
            外部サービス（例: Supabase、Vercel）を利用します。
          </p>
        </section>

        <section className={sectionClass}>
          <h2 className={h2Class}>4. データの保存と保護</h2>
          <p className={pClass}>
            記録・写真などのデータは、行レベルセキュリティ（RLS）によりアクセスを
            所有者・世帯のメンバーに限定して保護します。写真は非公開ストレージに保存し、
            期限付きの署名付き URL でのみ配信します。
          </p>
        </section>

        <section className={sectionClass}>
          <h2 className={h2Class}>5. データの開示・削除</h2>
          <p className={pClass}>
            利用者は、自身のデータの開示・訂正・削除を求めることができます。データの
            エクスポートおよびアカウント・世帯の削除機能は順次提供します。
          </p>
        </section>

        <section className={sectionClass}>
          <h2 className={h2Class}>6. Cookie 等の利用</h2>
          <p className={pClass}>
            本サービスは、ログインセッションの維持などに必要な Cookie を利用します。
            計測目的の Cookie を導入する場合は、別途同意の取得方法を定めます。
          </p>
        </section>

        <section className={sectionClass}>
          <h2 className={h2Class}>7. ポリシーの変更</h2>
          <p className={pClass}>
            本ポリシーは、必要に応じて変更されることがあります。変更後の内容は、本
            サービス上に掲示した時点から適用されます。
          </p>
        </section>

        <section className={sectionClass}>
          <h2 className={h2Class}>8. お問い合わせ</h2>
          <p className={pClass}>
            本ポリシーに関するお問い合わせは、本サービス内の
            <Link
              href="/feedback"
              className="mx-1 text-foreground underline underline-offset-2"
            >
              フィードバック
            </Link>
            からご連絡ください。
          </p>
        </section>
      </div>

      <p className="mt-10 text-center text-sm">
        <Link
          href="/terms"
          className="font-medium text-foreground underline underline-offset-2"
        >
          利用規約はこちら
        </Link>
      </p>
    </main>
  );
}
