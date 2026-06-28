import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import AppHeader from "@/components/AppHeader";

export const dynamic = "force-dynamic";

export const metadata = { title: "ヘルプ" };

const sectionClass =
  "space-y-2 rounded-2xl bg-surface p-5 shadow-sm ring-1 ring-border scroll-mt-20";
const h2Class = "text-lg font-bold text-foreground";
const pClass = "text-sm leading-relaxed text-foreground";
const ulClass = "list-disc space-y-1 pl-5 text-sm leading-relaxed text-foreground";
const inlineLink = "text-foreground underline underline-offset-2 hover:text-foreground";

export default async function HelpPage() {
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
        <h1 className="mb-1 text-xl font-bold text-foreground">ヘルプ</h1>
        <p className="mb-6 text-sm text-muted-foreground">
          mfmf の使い方をまとめています。困ったときに見にきてください。
        </p>

        <nav
          aria-label="目次"
          className="mb-6 rounded-2xl bg-surface-muted p-4 ring-1 ring-border"
        >
          <p className="mb-2 text-xs font-semibold text-muted-foreground">目次</p>
          <ul className="space-y-1 text-sm text-foreground">
            <li>
              <a href="#intro" className={inlineLink}>
                はじめに
              </a>
            </li>
            <li>
              <a href="#records" className={inlineLink}>
                記録を追加する
              </a>
            </li>
            <li>
              <a href="#photos" className={inlineLink}>
                写真について
              </a>
            </li>
            <li>
              <a href="#search" className={inlineLink}>
                検索・絞り込み
              </a>
            </li>
            <li>
              <a href="#shares" className={inlineLink}>
                共有リンク
              </a>
            </li>
            <li>
              <a href="#troubleshoot" className={inlineLink}>
                困ったとき
              </a>
            </li>
          </ul>
        </nav>

        <div className="space-y-4">
          <section id="intro" className={sectionClass}>
            <h2 className={h2Class}>はじめに</h2>
            <p className={pClass}>
              mfmf は、保育園とおうちでのペットの日々の記録（テキストと写真）を残し、
              夫婦で振り返るためのアプリです。1 つのアカウントを夫婦で共有して使う前提で
              作られています。
            </p>
            <p className={pClass}>
              画面上部のヘッダーから、ギャラリー🖼️ / カレンダー📅 / ペット🐾 /
              共有リンク🔗 / ヘルプ❓ / 設定⚙️ に移動できます。
            </p>
          </section>

          <section id="records" className={sectionClass}>
            <h2 className={h2Class}>記録を追加する</h2>
            <p className={pClass}>
              一覧画面の「＋ 新規」ボタン、または{" "}
              <Link href="/records/new" className={inlineLink}>
                /records/new
              </Link>{" "}
              から追加できます。
            </p>
            <ul className={ulClass}>
              <li>
                <strong>日付</strong>：いつの記録か。既定では今日が入ります。
              </li>
              <li>
                <strong>記録元</strong>：🏫 保育園 / 🏠 おうち のどちらか。
              </li>
              <li>
                <strong>記入者</strong>：誰が書いたか。設定画面で既定値を決められます。
              </li>
              <li>
                <strong>体重 (kg)</strong>：任意。入力すると体重グラフに反映されます。
              </li>
              <li>
                <strong>本文</strong>：その日の様子を自由に。
              </li>
              <li>
                <strong>タグ</strong>：自由なキーワードで分類できます（例: 散歩、病院）。
              </li>
              <li>
                <strong>写真</strong>：複数枚アップロードできます。
              </li>
            </ul>
            <p className={pClass}>
              作成した記録は一覧から開き、右上の「編集」「削除」で変更・削除できます。
            </p>
          </section>

          <section id="photos" className={sectionClass}>
            <h2 className={h2Class}>写真について</h2>
            <ul className={ulClass}>
              <li>1 つの記録に複数枚アップロードできます。</li>
              <li>
                送信前にブラウザで長辺 1600px に自動縮小・JPEG 化されるため、
                大きな写真でもそのまま選んで大丈夫です。
              </li>
              <li>
                すべての写真は{" "}
                <Link href="/gallery" className={inlineLink}>
                  ギャラリー🖼️
                </Link>{" "}
                から新しい順にまとめて見ることができます。
              </li>
            </ul>
          </section>

          <section id="search" className={sectionClass}>
            <h2 className={h2Class}>検索・絞り込み</h2>
            <p className={pClass}>
              一覧画面の上部にあるフィルタで、本文・記入者のキーワード検索、記録元 / 期間 /
              タグでの絞り込み、日付・体重での並び替えができます。
            </p>
            <p className={pClass}>
              絞り込んだ条件は URL に保存されるので、その URL を家族に送ったり
              ブックマークしておけば、同じ絞り込み結果をいつでも開き直せます。
            </p>
          </section>

          <section id="shares" className={sectionClass}>
            <h2 className={h2Class}>共有リンク</h2>
            <p className={pClass}>
              祖父母など、アプリにログインしない人にも記録を見せたい場合は、
              <Link href="/shares" className={inlineLink}>
                共有リンク🔗
              </Link>
              から閲覧専用のリンクを発行できます。
            </p>
            <ul className={ulClass}>
              <li>ラベル（メモ書き）・期間・有効期限を指定できます。</li>
              <li>
                <strong>写真は含まれず、テキストのみ</strong>が共有されます。
              </li>
              <li>「失効」をいつでも押せば、それ以降そのリンクは使えなくなります。</li>
            </ul>
          </section>

          <section id="troubleshoot" className={sectionClass}>
            <h2 className={h2Class}>困ったとき</h2>
            <ul className={ulClass}>
              <li>
                画面の右下にある「💬」ボタンから、不具合や要望を送れます。
                内容はアプリの管理者にだけ届きます。
              </li>
              <li>
                しばらく使わずにログインが切れた場合は、{" "}
                <Link href="/login" className={inlineLink}>
                  ログイン画面
                </Link>{" "}
                からもう一度サインインしてください。
              </li>
              <li>
                ホーム画面に追加して使うと、毎回ブラウザを開かずにすぐ起動できます
                （iPhone は Safari の共有メニュー →「ホーム画面に追加」、Android は
                Chrome のメニュー →「ホーム画面に追加」）。
              </li>
            </ul>
          </section>
        </div>
      </main>
    </>
  );
}
