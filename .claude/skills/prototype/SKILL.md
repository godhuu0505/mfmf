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
git fetch origin main
git switch -c proto/quick-record origin/main
```

**必ず `main` から切る。** 実装途中の feature ブランチから切ると、
未完成の変更が混ざって判断がぶれる。

### 2. 実コードで画面を作る

`src/app/proto/<slug>/page.tsx` に置く。

- **DB / migration は一切触らない。** 固定データを配列で直書きする
- Server Component をやめて `"use client"` の静的配列でよい
- `AppHeader` / `PhotoGallery` / `RecordForm` / トークン / ダークモード /
  セーフエリアは既存のものを `import` で使う（ここが速さの源）
- 型は既存の `src/types/database.ts`（`RecordWithPhotos` など）に合わせておくと、
  あとで「育てる」選択肢が残る
- **`just check` は回さない。** `next dev` が動けばよい

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

#### 現行画面と並べる（worktree）

`node_modules` は gitignore されていて新しい worktree には存在しないので、
**依存のインストールが要る**:

```bash
git worktree add ../mfmf-main origin/main
cd ../mfmf-main && npm ci                    # ← これが無いと next: not found
npm run dev -- -p 3001                       # :3000=proto, :3001=現行
cd - && git worktree remove ../mfmf-main     # 済んだら消す
```

### 4. 決定ログを書く（★ 順序に注意）

**`proto/` ブランチに決定ログを書いてはいけない。ブランチを消したら記録も消える。**

```
1. 合意 or 却下
2. 決めたこと・却下した案とその理由をメモ
3. git switch して実装ブランチ（or docs ブランチ）へ
4. そこで docs/explanation/decisions.md に 1 行書いてコミット
5. proto ブランチを削除
```

**却下したときこそ書く。** 実装 PR が発生しないので忘れやすいが、
「なぜ却下したか」はコードから復元できない唯一の情報。
1 行の docs だけの PR を作ってよい。

### 5. 畳む

**道 B: 捨てて書き直す（デフォルト）**

```bash
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

これは意図どおり（プロトに CI を回すのは無駄）だが、**そのブランチをそのまま
実装に育てる（道 A）つもりなら、push 前にローカルで `just check` を通しておく**。
捨てる前提（道 B）なら不要。

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
