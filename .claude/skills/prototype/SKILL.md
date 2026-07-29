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
- **`page.tsx` は Server Component のままにする。** データ取得を消して固定配列を
  直書きするだけでよい。操作が要る部分は**入れ子の `"use client"` コンポーネント**に切り出す
- 既存コンポーネントの再利用が速さの源だが、**import する前に必ず実装を開いて
  「送信・アップロード・遷移」が無いか確かめる**（→ 下記の判定）
- **ヘッダーはプロト内に静的なものを置く**（`AppHeader` は import しない → 下記）
- **固定データに実 ID を入れない。** `recordId` や `petId` を埋めると、
  コンポーネントによっては実画面へのリンクが生える（例: `PhotoGallery`）

> 🔍 **import してよいかの判定（これを毎回やる）**
> そのコンポーネントと**その子**に、次のどれかがあれば「表示専用」ではない:
>
> 1. `createClient()` / `supabase.` — 直接読み書きする
> 2. Server Action の呼び出し / `<form action=...>` — 送信する
> 3. `<Link href=...>` / `router.push` — **実画面へ出ていく**
>
> 実際にこの判定を怠って 4 回間違えている（下表）。目視で「表示専用っぽい」は当てにならない。
>
> | コンポーネント | 実際の副作用 |
> | --- | --- |
> | `RecordForm` | `handleSubmit` が action を呼ぶ**前に** `PHOTO_BUCKET` へ実アップロード（`:124-133`） |
> | `FeedbackWidget` | `layout.tsx` から**自動で載り**、実 `feedback` テーブルへ insert |
> | `AppHeader` | `AccountMenu` 経由で `/auth/signout`（実ログアウト）と `/settings/account` へ |
> | `PhotoGallery` | `recordId` があると `/records/<id>` への「記録を見る →」が出る（`:166-171`） |
>
> **安全に使える例**: `SourceIcon` / `PageSkeleton` / デザイントークン / ダークモード /
> セーフエリア（いずれも上の 3 つを持たない）。
> `PhotoGallery` も **`recordId` を渡さなければ**表示専用として使える。

**代替の作り方**（上表に当たったとき）:

- **ヘッダー** → `src/app/proto/<slug>/` に静的なものを置く。外枠クラスを写せば見た目は保てる:
  `safe-pt sticky top-0 z-10 border-b border-border bg-surface/80 backdrop-blur` ＋ 内側に
  `safe-px mx-auto flex max-w-2xl items-center justify-between py-3`。
  ロゴとアイコンは `<span>` にして遷移させない
  （`page.tsx` を `"use client"` にしたい場合の `next/headers` 問題も同時に消える）
- **入力フォーム** → 見た目だけ複製し、`onSubmit` は `console.log` か state 更新に留める
- **写真グリッド** → `PhotoGallery` に `recordId` を渡さない
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

**あわせて `FeedbackWidget` を止める。** `src/app/layout.tsx` が全ルートに無条件で描画しており、
`submitFeedback` は実 `feedback` テーブルに insert する（`src/app/feedback/actions.ts:75`）。
**プロト側が何も import しなくても勝手に付いてくる**ので、リモート Supabase 構成で触ると
プロトの画面から本物の行が入る（未ログインなら送信が必ず失敗する UI が出る）。

```diff
  // src/app/layout.tsx
        {children}
-       <FeedbackWidget />
+       {/* proto ブランチでは無効化（実 feedback テーブルに書くため）。畳むとき戻す */}
        <ServiceWorkerRegister />
```

> **`layout.tsx` から継承されるものに注意。** §2 の「バックエンドを書き換えるものを
> import しない」は自分で書くコードの話。レイアウト経由で**自動的に載るもの**は
> import していなくても付いてくるので、別途止める必要がある。

> **ローカル Supabase を使っている場合の注意**: `just setup` が書く
> `NEXT_PUBLIC_SUPABASE_URL` は `http://127.0.0.1:54321` で、スマホから見ると
> 「スマホ自身」を指すため到達できない。
> ただし §2 のとおりプロトは固定データ ＋ 静的ヘッダーで組むので、
> **プロト画面自体は Supabase に触らず、ローカル構成のままで問題ない**。

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

standalone 表示まで見たい場合は `npm run build && npm run start` を
HTTPS 経由（トンネル等）で当てる。**ただしそれだけでは足りない** ——
`src/app/manifest.ts:9` の `start_url` は `/` 固定なので、
ホーム画面から起動すると**プロトではなく通常の（認証必須の）トップ**が開く。
standalone にはアドレスバーが無いため、そこからプロトへ移動する手段も無い。
見るなら `start_url` を一時的にプロトのパスへ向け、畳むときに戻す必要がある。

さらに、本番ビルドでは `WebVitalsReporter`（`src/app/layout.tsx`）が有効になり、
プロトの計測値が `/api/vitals` 経由で Sentry に送られる（`SENTRY_DSN` 設定時）。
`/proto/...` は既知パスに無いので `other` に丸められ、**アプリの計測系列が汚れる**。

つまり standalone 検証は「HTTPS を用意する」だけでは終わらず、
manifest の一時改変・その復元・計測の無効化まで込みになる。
**プロト段階ではここまでやらない。** standalone 表示とオフライン挙動は、
実装後に本番相当で確認するほうが確実で安全。

> `dev-lan`（開発サーバー）では `WebVitalsReporter` が
> `NODE_ENV !== "production"` で早期 return するため送信されない。
> 汚染が起きるのは上記の本番ビルド経路だけ。

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
git fetch origin main                             # ← worktree add は fetch しない
git worktree add ../mfmf-main origin/main
ln -s "$PWD/.env.local" ../mfmf-main/.env.local   # ← 中身は読まない・出力しない
cd ../mfmf-main && npm ci                         # ← これが無いと next: not found
npm run dev -- -p 3001                            # :3000=proto, :3001=現行
cd - && git worktree remove ../mfmf-main          # 済んだら消す
```

`git worktree add` は指定した commit-ish を checkout するだけで**リモートから fetch しない**。
セッションをまたいだプロトではローカルの `origin/main` が古く、:3001 が
「現行」と称して**古い画面**を出しかねないので、直前に `git fetch` する。

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
git fetch origin main                           # ← 古い origin/main から書き始めない
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

# ★ 1) 採用した画面を本来のルートへ移す（先にこれ。順序を逆にすると消える）
mkdir -p src/app/<本来のルート>
git mv src/app/proto/quick-record/page.tsx src/app/<本来のルート>/page.tsx
#    複数案を作った場合は「採用した案」を移す（a/page.tsx など）。
#    比較用の入口 page.tsx（リンクとメモだけ）は移さず捨てる。
#    プロト内に切り出した client コンポーネントも忘れず移す。
#    既存ルートの刷新で移動先に page.tsx がある場合は `fatal: destination exists` で
#    止まるので、置き換えるつもりなら `git mv -f`（差分は次のコミットで確認できる）。

# ★ 2) プロト都合で触った「実アプリ側」の変更だけを取り消す
git diff --cached src/app/layout.tsx src/app/manifest.ts \
  src/lib/supabase/middleware.ts        # ← まず中身を見る
#    プロト都合の hunk だけを戻す（下記）。ファイル全体を戻してよいのは
#    「採用した機能がそのファイルを一切変更しない」と確認できたときだけ:
#    git restore --source=origin/main --staged --worktree <file>
git rm -r --quiet --ignore-unmatch src/app/proto

# ★ 3) 最終確認（--stat ではなく中身を見る）
git diff --cached
```

> 🧹 **掃除の規則（ファイル名を覚えるのではなく、これを守る）**
> **`src/app/proto/` の外の変更は、1 つずつ「実装に必要か / プロト都合か」を見て判断する。**
> プロト都合なら取り消す。§3 で触りうるのは典型的に
> `/proto` の認証除外・`FeedbackWidget` の無効化・`start_url` の一時変更。
>
> ⚠️ **ファイル全体を `git restore` で戻さない。**
> ナビ構造の刷新など、**採用した機能自体が `layout.tsx` を変更する**ことは普通にある
> （§1 が明示的に対象にしているケース）。全体を戻すと、その実装変更まで消える。
> しかも消えたファイルは `git diff --cached --stat` に現れないので、
> **`--stat` では気づけない**。最終確認は `--stat` ではなく差分の中身を見ること。
>
> `--ignore-unmatch` が要る理由: プロトが `page.tsx` 1 枚だけだった場合、
> 1) の `git mv` で追跡ファイルが無くなり `src/app/proto` 自体が消える。
> そのまま `git rm` すると `pathspec ... did not match any files` で**止まる**。

> ⚠️ **順序が命。** 育てたい UI は `src/app/proto/<slug>/` の中にある。
> 先に `git rm -r src/app/proto` すると、**残るのはプロト外の些末な変更だけ**になり、
> 道 A が保存したかったもの（＝画面そのもの）が消える。必ず `git mv` が先。
>
> 🔒 **`reset --soft` はプロトの足場も丸ごとステージする。**
> `src/app/proto/<slug>/` の固定データページと、§3 で入れた
> **`/proto` の認証除外**がそのまま実装 PR に乗る。
> このリポジトリは **main マージ＝本番リリース**なので、気づかず通すと
> **認証不要の `/proto` ルートが本番に出る**。落とす操作は任意ではなく必須。
>
> `git diff --cached --stat` に `src/app/proto` と `middleware.ts` が
> **残っていないこと**を目で確認してから §5 に進む。

> ⚠️ **`git rebase` を飛ばすと upstream の変更を巻き戻すコミットができる。**
> プロトを切ったあとに `origin/main` が進んでいる場合、`reset --soft` は
> HEAD を新しい main へ移す一方で**インデックスには古い main 基準のツリーが残る**。
> そのままコミットすると、プロトの変更に加えて
> **フォーク後に main へ入った全変更の削除・巻き戻しがステージされる**。
> セッションをまたいだプロトでは特に起きやすい。先に rebase して同じ基準に揃える。
>
> rebase が競合して面倒なら、道 B（捨てて書き直す）に切り替えたほうが速い。
> **ただし先に `git rebase --abort` する。** 競合で止まったままだと index に
> 未解決エントリが残り、道 B の `git switch main` が拒否されて始められない。

迷ったら **B**。書き直しは思ったより速い。

**却下した場合**（実装ブランチが発生しない）:

```bash
git status --porcelain                          # 空であること
git fetch origin main
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

**次のセッションで再開するとき**（§1 をやり直さない）:

```bash
git fetch origin proto/quick-record
git switch -c proto/quick-record origin/proto/quick-record   # 保存した続きから
```

§1 の `git switch -c proto/quick-record origin/main` を再実行すると、
**`origin/main` から作り直してしまい前回のプロトが消える**。
そのまま進めると push が non-fast-forward で弾かれる（弾かれるのは幸運なほうで、
その前に作業ツリー上のプロトを失っている）。再開時は必ず上のコマンドを使う。

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

- **プロト専用の変更を実装 PR に混ぜない。** main マージ＝本番リリースなので、
  混ざると本番に出る（認証不要の `/proto`・壊れた `start_url`・フィードバック導線の欠落）。
  道 A の最後で必ず落とし、PR を出す前に `git diff origin/main` を（`--stat` ではなく
  中身を）見て、**実装に必要だと一言で説明できない変更が無い**ことを確認する
- `mocks/` のような静的 HTML 置き場を作らない（実装プロトの方が速く情報量も多い）
- `proto/` に PR を作らない
- プロトタイプ用の feature flag を常設しない（消し忘れが残骸を生む）
- プロト段階で migration を書かない

## 背景・根拠

なぜこの形なのか、どの案を却下したかは
[docs/explanation/prototype-first.md](../../../docs/explanation/prototype-first.md) を参照。
