import Link from "next/link";

export const metadata = { title: "利用規約" };

// 利用規約（下書き・雛形）。
// 正式な文言・同意台帳の整備は #50（法務: 利用規約 / プライバシーポリシー / 特商法）で行う。
// 本ページは条項の骨子を用意する足場であり、確定した法務文言ではない。
// 公開（SIGNUP_ENABLED 開放）前に法務レビューを経て確定させること。
const LAST_UPDATED = "2026-07-06";

const sectionClass = "space-y-2";
const h2Class = "text-lg font-bold text-foreground";
const pClass = "text-sm leading-relaxed text-foreground";
const ulClass = "list-disc space-y-1 pl-5 text-sm leading-relaxed text-foreground";

export default function TermsPage() {
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

      <h1 className="mb-1 text-2xl font-bold text-foreground">利用規約</h1>
      <p className="mb-6 text-xs text-muted-foreground">最終更新日: {LAST_UPDATED}</p>

      {/* 下書きであることを明示するバナー（確定文言ではない）。 */}
      <div className="mb-8 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200">
        <p className="font-semibold">これは下書きです</p>
        <p className="mt-1 leading-relaxed">
          本利用規約は現在整備中の下書きであり、正式な法的効力を持つ最終版ではありません。
          正式版は一般公開の前に確定・掲載します。
        </p>
      </div>

      <div className="space-y-6">
        <section className={sectionClass}>
          <h2 className={h2Class}>第1条（適用）</h2>
          <p className={pClass}>
            本規約は、mfmf（以下「本サービス」）の利用に関する条件を、本サービスを
            利用するすべての利用者と運営者との間で定めるものです。利用者は、本規約に
            同意した上で本サービスを利用するものとします。
          </p>
        </section>

        <section className={sectionClass}>
          <h2 className={h2Class}>第2条（アカウント登録）</h2>
          <ul className={ulClass}>
            <li>利用者は、正確かつ最新の情報でアカウントを登録するものとします。</li>
            <li>
              アカウントおよびパスワードの管理責任は利用者が負うものとし、第三者への
              貸与・共有は原則として行わないものとします。
            </li>
          </ul>
        </section>

        <section className={sectionClass}>
          <h2 className={h2Class}>第3条（利用者のコンテンツ）</h2>
          <p className={pClass}>
            利用者が本サービスに登録した記録・写真等のコンテンツの権利は利用者に帰属
            します。運営者は、本サービスの提供に必要な範囲でこれらを保存・処理します。
          </p>
        </section>

        <section className={sectionClass}>
          <h2 className={h2Class}>第4条（禁止事項）</h2>
          <ul className={ulClass}>
            <li>法令または公序良俗に違反する行為</li>
            <li>他の利用者または第三者の権利を侵害する行為</li>
            <li>本サービスの運営を妨害する行為、不正アクセスを試みる行為</li>
          </ul>
        </section>

        <section className={sectionClass}>
          <h2 className={h2Class}>第5条（サービスの変更・中断・終了）</h2>
          <p className={pClass}>
            運営者は、利用者への事前の通知をもって、本サービスの内容を変更し、または
            提供を中断・終了することがあります。
          </p>
        </section>

        <section className={sectionClass}>
          <h2 className={h2Class}>第6条（免責事項）</h2>
          <p className={pClass}>
            運営者は、本サービスに事実上または法律上の瑕疵がないことを明示的にも黙示的
            にも保証しません。適用される法令で認められる範囲で、本サービスの利用により
            生じた損害について責任を負わないものとします。
          </p>
        </section>

        <section className={sectionClass}>
          <h2 className={h2Class}>第7条（規約の変更）</h2>
          <p className={pClass}>
            運営者は、必要と判断した場合に本規約を変更できるものとします。変更後の規約
            は、本サービス上に掲示した時点から効力を生じます。
          </p>
        </section>

        <section className={sectionClass}>
          <h2 className={h2Class}>第8条（お問い合わせ）</h2>
          <p className={pClass}>
            本規約に関するお問い合わせは、本サービス内の
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
          href="/privacy"
          className="font-medium text-foreground underline underline-offset-2"
        >
          プライバシーポリシーはこちら
        </Link>
      </p>
    </main>
  );
}
