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
- `npm run build` はプロト段階では任意（ただし**道 A で畳んだ後は必須** → §4）

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

**`import FeedbackWidget` の行はそのまま残す**（消さない）。この構成では未使用 import は
`npm run lint`（`next/core-web-vitals` に `no-unused-vars` は入っていない）でも
`npm run typecheck`（`tsconfig.json` に `noUnusedLocals` を置いていない）でも
**検出されない**ので、残しても 3 ゲートは通る。残しておけば §4 で戻すのが
JSX 1 行の復帰で済む。import も消すと復帰が 2 箇所になり、戻し忘れの面が増える。

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

- **手元の PC で 2 タブ並べる** → `127.0.0.1` が本当にローカルを指すので動く。
  レイアウト・配色・情報量の比較はこれで足りる。
  **ただし先に :3000 でログインを済ませておくこと**（下記）
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

> ⚠️ **:3001 で新規にログインしようとしない。先に :3000 でログインしておく。**
> `LoginForm` は `redirectTo` を `window.location.origin` から作るので、:3001 から
> Google ログインを始めると戻り先が `http://localhost:3001/auth/callback` になる。
> `supabase/config.toml` の `additional_redirect_urls` は **:3000 の 4 つだけ**を
> 許可しているため、この戻り先は弾かれる。
>
> **回避策は要らない。Cookie はポートで分離されない**（RFC 6265: Cookie のスコープは
> ドメインとパスで、ポートは含まない）。:3000 でログインしていれば、同じブラウザの
> :3001 にも同じセッション Cookie が送られ、**そのままログイン済みで開ける**。
> config.toml に :3001 を足す必要はない（足すと本番と乖離した許可リストが残る）。

`.env.local` も `node_modules` も gitignore されているので、新しい worktree には
**どちらも存在しない**。`NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` が
無いと `src/lib/supabase/middleware.ts` がクライアントを組めず、:3001 は現行画面を描けない。
**symlink で渡す**（`cat` などで中身を読み出さない。ガードフックにも抵触しない）。

最後の `git worktree remove` は、`npm ci` / `npm run dev` が作った `node_modules` `.next` と
上の `.env.local` symlink が残っていても **`--force` なしで成功する**（実測。exit 0）。
3 つとも `.gitignore` 済みで `git status --porcelain` が空 ＝ git はこの worktree を
clean と見なすため。**`--force` を足さないこと** —— 無視対象でない編集中の変更ごと
消し飛ばす操作なので、`.claude/hooks/guard.mjs` がブロックする。
判定はコマンド文字列をトークン列に分解して行うので、**語順・`git -C` 等のグローバル
オプション・`--for` のような省略形のいずれでも止まる**（`--no-force` は通す）。
`permissions.deny` は前方一致なのでこれらを取りこぼす。

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

#  2a) hunk 単位で戻す（既定。採用した機能も同じファイルを触っている場合はこれ）
#      -p が hunk ごとに y/n を訊く。プロト都合の hunk だけ y、実装の hunk は n。
git restore -p --source=origin/main --staged --worktree \
  src/app/layout.tsx src/app/manifest.ts src/lib/supabase/middleware.ts

#  2b) ファイル全体を戻す（そのファイルに実装側の変更が「一切ない」と 2) で確認できたときだけ）
#      git restore --source=origin/main --staged --worktree <file>

#  2c) 戻ったことを確認する。ここが空でなければまだプロト都合の変更が残っている
git diff --cached src/lib/supabase/middleware.ts | grep -n 'proto' || echo "OK: /proto の認証除外は残っていない"
git diff --cached src/app/layout.tsx | grep -n 'FeedbackWidget' || echo "OK: FeedbackWidget は戻っている"

git rm -r --quiet --ignore-unmatch src/app/proto

# ★ 3) 固定データと空の操作を「本物」に差し替える（★2 と ★4 の間。ここが本体）
grep -rn "const .*= \[" src/app/<本来のルート>/     # 直書き配列が残っていないか
grep -rn "console.log\|TODO\|onSubmit={() =>" src/app/<本来のルート>/
#    - 固定配列 → Server Component で supabase から取得する
#    - console.log / state 止まりのハンドラ → Server Action を呼ぶ
#    - 認可を入れる（新規作成なら requireEditableHousehold()、
#      更新/削除なら対象行の household で判定。CLAUDE.md の使い分けに従う）
#    - 0 件・エラー・権限なし（viewer）の分岐を足す

# ★ 4) 最終確認（--stat ではなく中身を見る）
git add -A                 # ★3 の編集は未ステージ。これが無いと下の確認もコミットも
                           #    「固定データのままの古い版」を見る/記録することになる
#    add できたかの確認は「未ステージ」と「未追跡」だけを見る。
#    `git status --porcelain` はステージ済みの行も出すので、空にはならない。
git diff --quiet || echo "⚠ 未ステージの変更が残っている"
[ -z "$(git ls-files --others --exclude-standard)" ] || echo "⚠ 未追跡ファイルが残っている"
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
> 🚨 **戻し忘れを検出する自動ゲートは無い。** `<FeedbackWidget />` を消したまま
> merge しても `lint` / `typecheck` / `build` は**3 つとも通る**（未使用 import も
> 素通りすることは §3 のとおり）。このリポジトリは **merge = 本番リリース**なので、
> 戻し忘れは「本番からご意見フォームが消える」形で出る。しかも消えたのは
> プロト都合の一時変更なので、レビューでも変更意図に見える。
> **`git diff --cached` を目で見る ★4 が唯一の防波堤**。省略しない。
>
> ⚠️ **`reset --soft` はプロトの版をステージ済みにする。** ★3 で書き直した内容は
> **未ステージの作業ツリー変更**として別に積まれる。★4 の `git add -A` を飛ばすと、
> `git diff --cached` は**固定データのままの古い版**を見せ、そのままコミットすると
> **本物の実装が入っていないもの**が記録される。差分を見て「大丈夫そう」と思えてしまうのが厄介。
>
> 🚨 **★3（固定データの差し替え）にも自動ゲートは無い。** 固定配列のまま本来のルートへ
> 移しても `lint` / `typecheck` / `build` は通る —— **型が合っている偽データ**であり、
> `console.log` 止まりのハンドラも静的には正しいコードだからだ。
> つまり**「動いているように見えて、読みも書きもしない画面」が本番に出る**。
> 道 A を選ぶなら ★3 を飛ばさない。飛ばす気があるなら最初から道 B（捨てて書き直す）にする。
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
> 確認は `git diff --cached`（`--stat` ではなく中身）で、
> **`/proto` の認証除外の hunk が残っていないこと**を見る。
> ファイル単位で「`middleware.ts` が消えていること」を条件にしない ——
> 採用した機能自体が middleware を変える（例: 新ルートを公開にする）ことは普通にあり、
> ファイル単位の判定だとその実装変更まで落とすことになる。
>
> **畳んだあとに `npm run lint` / `npm run typecheck` / `npm run build` を通す。**
> §2 のゲートは畳む「前」に走らせるものなので、`git mv`・hunk の取り消し・
> 既存ルートの置き換えで壊れた import やルーティングは捕まえられない。
> ここは UI / ルーティングの実装変更なので、リポジトリ規約どおり **build も必須**。

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
