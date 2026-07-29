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

```bash
just dev-lan
```

同じ Wi-Fi のスマホから `http://<表示された LAN IP>:3000/proto/quick-record` を開く。
mfmf は PWA なので、**片手操作・セーフエリア・IME・スクロールの確認は実機でしかできない**。
ここが静的モックに対する最大の優位点なので、省略しない。

現行画面と並べたいときは worktree:

```bash
git worktree add ../mfmf-main origin/main
cd ../mfmf-main && npm run dev -- -p 3001    # :3000=proto, :3001=現行
git worktree remove ../mfmf-main             # 済んだら消す
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
git reset --soft origin/main        # 履歴だけ畳む。作業ツリーは残る
git switch -c claude/<topic>-<hash>
git branch -D proto/quick-record
```

迷ったら **B**。書き直しは思ったより速い。

## ブランチ規約

| prefix | push | PR | CI | 寿命 |
| --- | --- | --- | --- | --- |
| `claude/<topic>-<hash>`（実装） | する | **作る** | 走る | PR マージまで |
| **`proto/<slug>`** | **原則しない** | **作らない** | 走らせない | 合意まで |

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

push すると `src/app/proto/` も CI の lint / typecheck / build 対象に入るので、
型が通っている必要がある。

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
