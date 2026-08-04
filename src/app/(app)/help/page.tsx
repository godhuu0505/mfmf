import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  CalendarDays,
  CircleHelp,
  House,
  Images,
  Menu as MenuIcon,
  MessageCircle,
  PawPrint,
  School,
  Settings,
} from "lucide-react";

// 文中に差し込む小さなアイコン（テキストのベースラインに揃える）。
const inlineIcon = "inline-block h-4 w-4 align-text-bottom";

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
                家族・第三者と共有する
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
              画面下のタブバーから、ホーム
              <House className={inlineIcon} aria-hidden="true" /> / カレンダー
              <CalendarDays className={inlineIcon} aria-hidden="true" /> / アルバム
              <Images className={inlineIcon} aria-hidden="true" /> / メニュー
              <MenuIcon className={inlineIcon} aria-hidden="true" /> に移動できます。
              中央のオレンジの「＋」がクイック記録です。ペット
              <PawPrint className={inlineIcon} aria-hidden="true" /> / 体重 / 設定
              <Settings className={inlineIcon} aria-hidden="true" /> / ヘルプ
              <CircleHelp className={inlineIcon} aria-hidden="true" />{" "}
              はメニューの中にあります。
            </p>
          </section>

          <section id="records" className={sectionClass}>
            <h2 className={h2Class}>記録を追加する</h2>
            <p className={pClass}>
              タブバー中央の「＋」を押すと<strong>クイック記録</strong>が開きます。
              「ごはん完食」「さんぽ」などのチップを選ぶだけで、文字入力なしで
              その日の記録を 1 件残せます。
            </p>
            <p className={pClass}>
              写真を付けたり日付・体重まで書きたいときは、クイック記録の
              「写真つきでくわしく記録する →」から記録フォーム（
              <Link href="/records/new" className={inlineLink}>
                /records/new
              </Link>
              ）に進みます（選んだチップは引き継がれます）。
            </p>
            <ul className={ulClass}>
              <li>
                <strong>日付</strong>：いつの記録か。既定では今日が入ります。
              </li>
              <li>
                <strong>記録元</strong>：
                <School className={inlineIcon} aria-hidden="true" /> 保育園 /{" "}
                <House className={inlineIcon} aria-hidden="true" /> おうち のどちらか。
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
              作成した記録は一覧から開き、詳細画面右上の「…」（その他の操作）から
              編集・ゲストへの共有・削除ができます。保存やキャンセルの際は
              確認ダイアログが出るので、書きかけの内容をうっかり失うことはありません。
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
                  ギャラリー
                  <Images className={inlineIcon} aria-hidden="true" />
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
            <h2 className={h2Class}>家族・第三者と共有する</h2>
            <p className={pClass}>
              記録を家族や保育園にも見てもらいたい場合は、
              <Link href="/settings" className={inlineLink}>
                設定
                <Settings className={inlineIcon} aria-hidden="true" />
              </Link>
              から相手を招待します。相手にもアカウントで参加してもらう形になり、
              誰がいつ見たかがわかる安全な共有になります。
            </p>
            <ul className={ulClass}>
              <li>
                祖父母など家族に見せる → <strong>viewer として招待</strong>
                （閲覧のみ・世帯の記録すべて）。
              </li>
              <li>
                保育園・シッターに預ける → <strong>ゲストとして招待</strong>
                （対象のペット・期間を限定）。
              </li>
              <li>招待はいつでも取り消せます。取り消すと相手は見られなくなります。</li>
            </ul>
            <p className={pClass}>
              以前あった、URL を知っていれば誰でも見られる「匿名の共有リンク」は
              廃止されました。
            </p>
          </section>

          <section id="troubleshoot" className={sectionClass}>
            <h2 className={h2Class}>困ったとき</h2>
            <ul className={ulClass}>
              <li>
                <Link href="/menu" className={inlineLink}>
                  メニュー
                </Link>
                の「
                <MessageCircle className={inlineIcon} aria-hidden="true" />{" "}
                ご意見・不具合」から、不具合や要望を送れます。
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
