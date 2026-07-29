---
name: prototype
description: UI のある新機能の画面・挙動を、使い捨てブランチ（proto/<slug>）の実コードで先に形にして合意を取る手順。新機能の画面を検討したい・複数案を比べたい・実機で触り心地を確かめたいときに使う。バックエンドのみの変更、既存画面の小改修、バグ修正では使わない。
---

# プロトタイプ駆動で新機能の画面を決める

**目的**: 仕様を文章で確定する前に、動くものを実機で触って合意する。
**原則**: リポジトリに成果物を残さない。永続化するのは決定ログ 1 行だけ。

## いつ使うか / 使わないか

| ケース | プロト |
| --- | --- |
| UI のある新機能 | **要** |
| 大きな UI 刷新（ナビ構造の変更など） | **要（複数案）** |
| DB 変更が要る機能 | 要（ただし固定データのみ。migration は仕様確定後） |
| バックエンドのみ（RLS・migration・認可修正） | **不要** |
| 既存画面の小改修（ボタン位置・文言） | **不要** |
| バグ修正 | **不要** |

判断基準: **一文で差分を説明できるならプロトは飛ばす。**
プロトの価値は「実機で触らないと分からないこと」に限定される。

発散段階（まだ何も決まっていない）は、リポジトリではなく
Claude Artifact などで 3 案を 1 枚に並べて捨てる方が速い。

## 手順

### 1. main から `proto/<slug>` を切る

```bash
git status --porcelain     # ← 空であることを確認（下記の理由）
git fetch origin main
git switch -c proto/quick-record origin/main
```

**必ず `main` から切る。** 実装途中の feature ブランチから切ると、
未完成の変更が混ざって判断がぶれる。

> ⚠️ **`switch -c` は作業ツリーの変更を持ち越す。** 分岐点が `origin/main` でも、
> 競合しない未コミット変更は**そのまま新ブランチに付いてくる**（`git switch` の仕様）。
> 作業中の feature ブランチから始めると、未完成の変更がプロトに混ざって
> 「main から切った」という前提が崩れる。汚れていれば先に commit か `git stash`。

### 2. 実コードで画面を作る

`src/app/proto/<slug>/page.tsx` に置く。

- **DB / Storage / migration は一切触らない。** 固定データを配列で直書きする
- Server Component をやめて `"use client"` の静的配列でよい
- **表示専用のもの**は既存を `import` して使う（ここが速さの源）:
  `AppHeader` / `PhotoGallery` / `SourceIcon` / `PageSkeleton` /
  デザイントークン / ダークモード / セーフエリア

> ⚠️ **バックエンドを書き換えるコンポーネントをそのまま import しない。**
> 代表例が `RecordForm` —— `handleSubmit` は渡された action を呼ぶ**前に**
> ブラウザ側 Supabase クライアントを作り、`PHOTO_BUCKET` へ写真を実アップロードする
> （`src/components/RecordForm.tsx:124-133`）。
> **action を no-op にしても写真は本物の Storage に書き込まれる**。
> リモート Supabase 構成なら本番相当のバケットが汚れ、ローカル構成なら
> スマホから `127.0.0.1` に届かず送信自体が失敗する。どちらにせよプロトの前提を壊す。
>
> 入力フォームをプロトで見たいときは、**見た目だけ複製した表示専用フォーム**を
> `src/app/proto/<slug>/` 内に置き、`onSubmit` は `console.log` か state 更新に留める。
> 同じ理由で、Server Action を呼ぶコンポーネントもそのままでは使わない。
- 型は既存の `src/types/database.ts`（`RecordWithPhotos` など）に合わせておくと、
  あとで「育てる」選択肢が残る
- **区切りごとにコミットする。** メッセージは雑でよい（`wip: proto` 等）。
  道 A の `rebase`、道 B の切り離しは**どちらもコミット済みであることが前提**
  （未コミットのまま `git switch` すると変更が実装ブランチへ持ち越される → §5 道 B）

**検証ゲートの扱い**（リポジトリ規約との関係）:

- 触っている最中は `just check` を回さない。`next dev` が動けばよい（速度優先）
- ただし **プロトの世界から何かが出ていく直前**——
  ①`push` する / ②道 A で実装に育てる / ③挙動が怪しくて判断に迷う——
  のいずれかなら **`npm run lint` と `npm run typecheck` を通す**
- `npm run build` はプロト段階では任意

> `tsc --noEmit` はプロジェクト全体を見るが、`next dev` が型を報告するのは
> そのとき実際にコンパイルしたルートだけ。プロト以外の場所を巻き込んで壊していても
> dev では気づけないことがある。だから「出ていく直前」には通す。

複数案を比べるときは**ブランチを増やさず**ルートを分ける:

```
src/app/proto/quick-record/
  a/page.tsx      案A
  b/page.tsx      案B
  page.tsx        両方へのリンクと比較メモ
```

### 3. 実機で触る

**先に `/proto` を認証から外す。** `src/middleware.ts` は全ルートに認証を要求するので、
外さないとスマホは `/login` に飛ばされる。捨てるブランチなので安全に外せる:

```diff
  // src/lib/supabase/middleware.ts の isPublicRoute
    const isPublicRoute =
      pathname === "/offline" ||
+     pathname.startsWith("/proto") ||
      pathname.startsWith("/auth") ||
```

> **ローカル Supabase を使っている場合の注意**: `just setup` が書く
> `NEXT_PUBLIC_SUPABASE_URL` は `http://127.0.0.1:54321` で、スマホから見ると
> 「スマホ自身」を指すため到達できない。プロトは固定データなので Supabase は不要だが、
> `AppHeader` は Server Component で `getUser()` を呼ぶ。ローカル Supabase 構成のまま
> 使うならヘッダーはプロト内で静的なものに差し替えるか、
> リモート Supabase 構成（README クイックスタート A）で起動する。

```bash
just dev-lan
```

同じ Wi-Fi のスマホから `http://<表示された LAN IP>:3000/proto/quick-record` を開く。

**この経路で確認できること**（＝静的モックに対する優位点。省略しない）:

- 片手で親指が届くか / タップ領域の大きさ
- IME が立ち上がったときにフォームが隠れないか
- スクロールの挙動、0 件のとき / 200 件あるときの成立
- ダークモード追従、セーフエリア（`env(safe-area-inset-*)` は通常のブラウザでも効く）

**この経路では確認できないこと**（ここは正直に割り切る）:

- **PWA スタンドアロン表示**（ホーム画面から起動した状態）。
  Service Worker は secure context（HTTPS か localhost）でしか動かず、
  LAN IP の平文 HTTP は secure context ではない。加えて
  `src/components/ServiceWorkerRegister.tsx` は `NODE_ENV !== "production"` のとき
  登録自体をスキップする
- オフライン挙動・SW キャッシュ

standalone 表示まで見たい場合だけ、`npm run build && npm run start` を
HTTPS 経由（トンネル等）で当てる。プロト段階では通常そこまでやらない。

#### 現行画面と並べる（worktree）— **手元ブラウザ用。スマホからは使えない**

:3001 が出すのは**現行の画面**なので、`/proto` の認証除外は効かず認証が要る。
ローカル Supabase 構成（`NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321`）では、
スマホのブラウザはその URL を**スマホ自身**として解決するのでログインを完了できない。

- **手元の PC で 2 タブ並べる** → `127.0.0.1` が本当にローカルを指すので問題なく動く。
  レイアウト・配色・情報量の比較はこれで足りる
- **スマホで現行画面と並べたい** → リモート Supabase 構成（README クイックスタート A）が必要。
  そこまでするより、現行画面はスマホの既存 PWA / 本番 URL で見て、
  :3000 のプロトと見比べるほうが速い


手元 PC で並べる場合の手順:

```bash
git worktree add ../mfmf-main origin/main
ln -s "$PWD/.env.local" ../mfmf-main/.env.local   # ← 中身は読まない・出力しない
cd ../mfmf-main && npm ci                         # ← これが無いと next: not found
npm run dev -- -p 3001                            # :3000=proto, :3001=現行
cd - && git worktree remove ../mfmf-main          # 済んだら消す
```

`.env.local` も `node_modules` も gitignore されているので、新しい worktree には
**どちらも存在しない**。`NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` が
無いと `src/lib/supabase/middleware.ts` がクライアントを組めず、:3001 は現行画面を描けない。
**symlink で渡す**（`cat` などで中身を読み出さない。ガードフックにも抵触しない）。

### 4. 畳む（★ 決定ログより先。順序を逆にすると詰む）

合意 or 却下が出たら、**まずブランチを畳んで、行き先のブランチを作る**。
決定ログはその行き先に書く（§5）。

> 逆順にすると: 先に `git switch -c claude/<topic>-<hash>` で実装ブランチを作って
> 決定ログを書き、その後で道 A / 道 B を実行しようとすると、
> どちらも `git switch -c` で**同じ名前のブランチを作ろうとして失敗する**。
> 別名にすれば決定ログのコミットだけ別ブランチに取り残される。

**前提: プロトの変更はコミット済みにしておく**（§2）。
未コミットのまま `git switch` すると、競合しない変更は**そのまま持ち越される** ——
固定データ・`/proto` ページ・`/proto` の認証除外が実装ブランチに紛れ込む。
`git branch -D` が消すのは ref だけで、作業ツリーは消えない。

```bash
git status --porcelain     # ← 空であることを確認してから進む
```

**道 B: 捨てて書き直す（デフォルト）**

```bash
git status --porcelain                          # 空であること
git switch main
git branch -D proto/quick-record
git switch -c claude/<topic>-<hash> origin/main
```

プロトは固定データ直書き・エラー処理なしの雑さを許して速度を出している。
その雑さを実装に持ち込まない。

**道 A: 育てる（既に実装品質に近いとき）**

```bash
git switch proto/quick-record
git fetch origin main
git rebase origin/main              # ★ 先に main へ追従させる（下記の理由）
git reset --soft origin/main        # 履歴だけ畳む。作業ツリーは残る
git switch -c claude/<topic>-<hash>
git branch -D proto/quick-record
```

> ⚠️ **`git rebase` を飛ばすと upstream の変更を巻き戻すコミットができる。**
> プロトを切ったあとに `origin/main` が進んでいる場合、`reset --soft` は
> HEAD を新しい main へ移す一方で**インデックスには古い main 基準のツリーが残る**。
> そのままコミットすると、プロトの変更に加えて
> **フォーク後に main へ入った全変更の削除・巻き戻しがステージされる**。
> セッションをまたいだプロトでは特に起きやすい。先に rebase して同じ基準に揃える。
>
> rebase が競合して面倒なら、道 B（捨てて書き直す）に切り替えたほうが速い。

迷ったら **B**。書き直しは思ったより速い。

**却下した場合**（実装ブランチが発生しない）:

```bash
git status --porcelain                          # 空であること
git switch main
git branch -D proto/quick-record
git switch -c claude/decision-<slug> origin/main   # docs だけのブランチ
```

### 5. 決定ログを書く

§4 で作った行き先のブランチ（実装ブランチ、却下なら docs ブランチ）で
`docs/explanation/decisions.md` に 1 行書いてコミットする。

**`proto/` ブランチには絶対に書かない。** 消したら記録も消えるため、
§4 で畳んでから書くこの順序になっている。
畳む前に決定内容をチャットか手元にメモしておくこと（ブランチと一緒に消えるのは
コードだけで、判断は消してはいけない）。

**却下したときこそ書く。** 実装 PR が発生しないので忘れやすいが、
「なぜ却下したか」はコードから復元できない唯一の情報。
1 行の docs だけの PR を作ってよい。

## ブランチ規約

| prefix | push | PR | CI | 寿命 |
| --- | --- | --- | --- | --- |
| `claude/<topic>-<hash>`（実装） | する | **作る** | PR で走る | PR マージまで |
| **`proto/<slug>`** | **原則しない** | **作らない** | **走らない**（PR が無いため） | 合意まで |

`proto/` prefix 自体が「PR にしないブランチ」の宣言。

### push するのはセッションをまたぐときだけ

Claude Code on the web のコンテナは揮発するので、ローカルのみのブランチは
セッション終了で消える（**1 セッションで完結するなら、これが自動クリーンアップになる**）。
続きを別日にやる場合だけ:

```bash
git push -u origin proto/quick-record
# PR は作らない。合意後にリモートも消す:
git push origin --delete proto/quick-record
```

**push しても CI は走らない。** `.github/workflows/ci.yml` の
トリガーは `pull_request` と `workflow_call` だけで、`proto/` に PR は作らないため。
つまりリモートの `proto/` ブランチは lint / typecheck / build を一度も通っていない状態で残る。

これは意図どおり（捨てるブランチに CI を回すのは無駄）。
ただし **push は「プロトの世界から出ていく」ことなので、§2 の検証ゲートが適用される** ——
push 前に `npm run lint` と `npm run typecheck` を通す。`npm run build` は任意。

### 遠隔の相手に見せる

`vercel.json` は `git.deploymentEnabled: false` で自動プレビューが出ない。
LAN が使えない相手には**画面録画（iOS / Android 標準）を送る**。
このためだけにプレビュー用 CI/CD を足さない。

## やらないこと

- `mocks/` のような静的 HTML 置き場を作らない（実装プロトの方が速く情報量も多い）
- `proto/` に PR を作らない
- プロトタイプ用の feature flag を常設しない（消し忘れが残骸を生む）
- プロト段階で migration を書かない

## 背景・根拠

なぜこの形なのか、どの案を却下したかは
[docs/explanation/prototype-first.md](../../../docs/explanation/prototype-first.md) を参照。
