---
name: prototype
description: UI のある新機能の画面・挙動を、自己完結した静的 HTML/CSS/JS のプロトタイプで先に形にし、Claude Artifact に publish してスマホで合意を取る手順。新機能の画面を検討したい・複数案を比べたい・実機で触り心地を確かめたいときに使う。バックエンドのみの変更、既存画面の小改修、バグ修正では使わない。
---

# プロトタイプ駆動で新機能の画面を決める

**目的**: 仕様を文章で確定する前に、動くものをスマホで触って合意する。
**形式**: 自己完結した**静的 HTML/CSS/JS**（[D24](../../../docs/explanation/decisions.md)）。
**確認**: Claude Artifact に publish して URL をユーザーに渡す。

> **実コードでプロトを作らないこと**（旧 D15）。理由は 2 つ:
> Artifact は自己完結 HTML しか受け付けないので実コードは載せられない。そして実コードプロトは
> **本物を壊した実績がある** —— `RecordForm` が実 Storage へアップロード、`FeedbackWidget` が
> 実テーブルへ insert、`AppHeader` が実セッションをログアウト、`PhotoGallery` が実記録へリンク。
> 静的ならこの経路が存在しない。

## いつ使うか / 使わないか

| ケース | プロト |
| --- | --- |
| UI のある新機能 | **要** |
| 大きな UI 刷新（ナビ構造の変更など） | **要（複数案を 1 枚に並べる）** |
| DB 変更が要る機能 | 要（データは JS の固定配列でモック。migration は仕様確定後） |
| バックエンドのみ（RLS・migration・認可修正） | **不要** |
| 既存画面の小改修（ボタン位置・文言） | **不要**（実コードを直接触る方が速い） |
| バグ修正 | **不要** |

判断基準: **一文で差分を説明できるならプロトは飛ばす。**

## 手順

### 1. 壁打ちで「作りたいこと」を言語化する

解像度は粗くてよい。ここで完璧な仕様を作ろうとしないこと —— 決まらないから
プロトを作る。**画面に出るもの・押せるもの・押した結果**が言えれば十分。

### 2. 静的 HTML を書く

置き場所は [`proto/<slug>/`](../../../proto/)（リポジトリ内。PR に含める → [D27](../../../docs/explanation/decisions.md)）。
本番ビルドには影響しません（`globals.css` の `@source not "../../proto"` で Tailwind の
走査対象から外してある）。

```
proto/<slug>/
├── index.html      ← 単一ファイル。複数案なら a.html / b.html / c.html
└── notes.md        ← 何を確かめたいか。合意後にスペックの素になる
```

**本番と同じ Tailwind クラス名を使うこと。** これが効くのは、
実装時のマークアップ移植が `class` → `className` の機械変換で済むからです。
独自のクラス名や inline style を使うと、その利点が消えます。

データは JS の固定配列でモックする。API は呼ばない（`fetch` を書かない）。
0 件・1 件・200 件のように**極端な状態を切り替えられる**ようにしておくと、
実機で確かめたいことがその場で試せます。

### 3. CSS を生成してインラインする

Artifact は外部ファイルを読めないので、CSS は HTML に埋め込みます。
Tailwind CLI に `@source` でその HTML を渡すと、**使っているクラスだけ**の CSS が出ます。

```bash
# 入力 CSS はリポジトリ内に置く（node_modules を解決するため）
cat > .proto-tmp.css <<EOF
@import "tailwindcss" source(none);
@source "$(pwd)/proto/<slug>/index.html";
EOF
# globals.css の @source not 行より後ろ（トークン・ダークモード・セーフエリア等）を全部取り込む。
# 行番号指定（sed -n '3,50p'）は globals.css が伸びると黙って途中で切れるので使わない（一度踏んだ）。
sed '1,/^@source not/d' src/app/globals.css >> .proto-tmp.css
npx @tailwindcss/cli -i .proto-tmp.css -o proto/<slug>/proto.css
rm .proto-tmp.css
```

実測: **55ms / 8.8KB**。`globals.css` のデザイントークンは素の CSS 変数なので、
**本番と同じ配色・ダークモード（`prefers-color-scheme`）・セーフエリア（`env(safe-area-inset-*)`）**
がそのまま効きます。

生成した `proto.css` を `<style>` として `index.html` に埋め込んでから publish します。

### 4. Artifact に publish してスマホで確認してもらう

`Artifact` ツールで `proto/<slug>/index.html` を publish し、URL をユーザーに渡す。

- **favicon を必ず指定する**（タブで見分けるため）
- 再 publish は**同じファイルパス**で行う。URL が変わらない
- 複数案は 1 つの Artifact に入口ページを作って並べるか、案ごとに publish する

**Artifact で確認できないもの**: PWA のスタンドアロン表示、オフライン挙動、
ホーム画面追加。Service Worker が要るこれらは Vercel Preview でしか見られません。
プロトだけでスタンドアロン前提の判断を確定させないこと。

### 5. 実機で触って合意する

見るべきは**文章では分からないこと**に限ります。

- 片手で親指が届く位置にボタンがあるか
- セーフエリア（ノッチ・ホームインジケータ）に被らないか
- IME が立ち上がったときにフォームが隠れないか
- 記録が 0 件のとき / 200 件あるときに画面が成立するか

合意できなければ 2 に戻る。**ここで往復するのが正しい**（実装後に往復するより桁違いに安い）。

### 6. 受け入れ条件を洗い出す

合意した瞬間が一番解像度が高いので、ここで**徹底的に**洗い出します（[D25](../../../docs/explanation/decisions.md)）。

ユースケース単位で「**どう操作し → どう振る舞い → どういう結果になるか**」を書く。
これがそのまま E2E テストになります。

```
UC: 保育園から帰ったあと、ごはんの記録を 3 タップで残す
  WHEN 一覧画面で「クイック記録」を押す
  THEN 記録シートが下から出る
  WHEN 「ごはん」を選んで「保存」を押す
  THEN シートが閉じ、一覧の先頭に今日の日付で「ごはん」が出る
  THEN リロードしても残っている
```

異常系・権限（viewer）・0 件も忘れないこと。

### 7. スペックを書く

`proto/<slug>/spec.md` に、**ユーザーから見える振る舞い**だけを書く。
画面表・データモデル・RLS は書かない（コードが正 → [D16](../../../docs/explanation/decisions.md)）。

### 8. 実装する

プロトとスペックと受け入れ条件が揃っているので、ここは一気に進めます。

1. E2E テストを先に書く（この時点では落ちる）。基盤は導入済み（Playwright / `tests/e2e/`、
   `npm run test:e2e`。ローカル Supabase と `npm run build` が前提 → `playwright.config.ts`）
2. マークアップをプロトから移植（`class` → `className`）
3. 固定データを実データに差し替える
   - Server Component で supabase から取得する
   - 認可を入れる（新規作成なら `requireEditableHousehold()`、更新/削除は**対象行の世帯**で判定。`CLAUDE.md` の使い分けに従う）
   - 0 件・エラー・権限なし（viewer）の分岐を足す
4. E2E が通ることを確認する
5. `just check`（lint / typecheck / build）

### 9. PR を出す

`proto/<slug>/` を含めたまま PR を出します（レビューで実物が見られるように）。

> **マージ時に CI がプロトとスペックをアーカイブへ移す**予定です（[D27](../../../docs/explanation/decisions.md)）。
> **この CI はまだ実装していません。** それまでは手で
> [`docs/archive/<slug>/`](../../../docs/archive/) へ移動してください。

## やらないこと

- **実 API・実 DB を呼ぶプロトを作る** —— 本物を壊す。固定データだけを使う
- **プロトに認証・認可を実装する** —— 確認したいのは画面であって認可ではない
- **プロトのために本体コードを触る** —— 触ったら、それは実装であってプロトではない
- **プロトを綺麗に書く** —— 捨てる前提ではないが、育てる前提でもない。合意に必要な分だけ
- **独自のクラス名や inline style を使う** —— 実装時の移植性が消える

## 背景・根拠

なぜこの形にしたかは [prototype-first.md](../../../docs/explanation/prototype-first.md)。
決定そのものは [decisions.md](../../../docs/explanation/decisions.md) の D24〜D27。
