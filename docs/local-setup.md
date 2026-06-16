# ローカル環境構築ガイド

mfmf（ペット保育園記録アプリ）をローカルで動かすための手順です。
バックエンド（DB / 認証 / Storage）の用意の仕方で **A / B の 2 通り** があります。

- **A. リモートの Supabase に繋ぐ（推奨・最短）** — 既にクラウド上にある Supabase プロジェクトをそのまま使う。
- **B. Supabase CLI でローカルにスタックを立てる** — Docker でローカルに Supabase 一式を起動する。スキーマ変更を試したいときに。

どちらの場合も、アプリ本体（Next.js）は `npm run dev` でローカル起動します。

---

## 前提ツール

| ツール | バージョン目安 | 用途 |
| --- | --- | --- |
| Node.js | 20 LTS 以上 | Next.js の実行 |
| npm | Node.js 同梱 | パッケージ管理 |
| Git | 任意 | クローン |
| Docker Desktop | 任意（B のみ） | Supabase ローカルスタック |
| Supabase CLI | 任意（B のみ） | ローカルスタック起動・マイグレーション |

```bash
node -v   # v20.x 以上であることを確認
npm -v
```

---

## 0. クローン & 依存インストール（共通）

```bash
git clone https://github.com/godhuu0505/mfmf.git
cd mfmf
npm install
```

---

## A. リモートの Supabase に繋ぐ（推奨）

### A-1. Supabase プロジェクトを用意

すでに `mfmf` プロジェクトが存在する場合はそれを使います（新規に作る必要はありません）。
無い場合は [Supabase ダッシュボード](https://supabase.com/dashboard) で新規プロジェクトを作成し、
`supabase/migrations/0001_init.sql` を **SQL Editor** に貼り付けて実行してください
（テーブル / RLS / Storage バケット `daycare-photos` が作られます）。

### A-2. 接続情報を取得

Supabase ダッシュボード > **Project Settings > API** から以下を控えます。

- **Project URL** … `https://<PROJECT_REF>.supabase.co`
- **anon / publishable key** … クライアントに埋め込まれる公開鍵（`NEXT_PUBLIC_` で使う前提のキー）

> anon キーはクライアント側に露出する前提の公開鍵です。RLS でデータを保護しているため公開しても問題ありません。
> 一方 `service_role` キーは絶対にフロントや `.env.local` に置かないでください（本アプリでは使いません）。

### A-3. 環境変数を設定

```bash
cp .env.local.example .env.local
```

`.env.local` を開き、A-2 の値を設定します。

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://<PROJECT_REF>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon または publishable key>
```

### A-4. ログイン用ユーザーを発行

サインアップ UI は無いため、ダッシュボードで手動発行します。
**Authentication > Users > Add user** から email / password を登録してください（夫婦で最大 2 人）。

### A-5. 開発サーバー起動

```bash
npm run dev
```

ブラウザで http://localhost:3000 を開き、A-4 のユーザーでログインできれば成功です。

---

## B. Supabase CLI でローカルにスタックを立てる

スキーマやマイグレーションを安全に試したいとき向け。Docker が必要です。

### B-1. Supabase CLI を用意

```bash
# macOS (Homebrew)
brew install supabase/tap/supabase

# それ以外は npm 経由でも可
npm install -g supabase

supabase --version
```

### B-2. ローカルスタックを起動

リポジトリ直下（`supabase/` がある場所）で実行します。

```bash
supabase start
```

初回は Docker イメージの取得に数分かかります。起動が完了すると、
**API URL** / **anon key** / **Studio URL** などが出力されます。
`supabase/migrations/` 配下のマイグレーション（`0001_init.sql`）は起動時に自動適用されます。

> いつでも `supabase status` で接続情報を再表示できます。
> ローカル Studio（http://localhost:54323 付近）からテーブルやユーザーを確認できます。

### B-3. 環境変数をローカルスタックに向ける

`supabase start` / `supabase status` が出力した値を `.env.local` に設定します。

```dotenv
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<supabase status が表示する anon key>
```

### B-4. ログイン用ユーザーを発行

ローカル Studio の **Authentication > Users** から、もしくは CLI で作成します。

### B-5. 開発サーバー起動

```bash
npm run dev
```

http://localhost:3000 でローカルスタックに繋がります。
終了時はスタックを止めます。

```bash
supabase stop
```

---

## よく使うコマンド

```bash
npm run dev        # 開発サーバー (http://localhost:3000)
npm run build      # 本番ビルド
npm run start      # 本番ビルドの起動
npm run lint       # ESLint
npm run typecheck  # tsc --noEmit による型チェック
npm run icons      # PWA アイコンを再生成 (scripts/generate-icons.mjs)
```

---

## トラブルシュート

| 症状 | 原因 / 対処 |
| --- | --- |
| 起動時に `NEXT_PUBLIC_SUPABASE_URL` 関連でエラー | `.env.local` 未設定 / 値が空。`.env.local.example` を元に設定し、`npm run dev` を再起動。 |
| ログインできない | ユーザー未発行、または email/password 間違い。ダッシュボード（or Studio）の Authentication > Users を確認。 |
| 一覧は出るが他人のデータが見える / 見えない | RLS が `owner_id = auth.uid()` 前提。マイグレーション未適用の可能性。`0001_init.sql` を再適用。 |
| 写真が表示されない | Storage バケット `daycare-photos`（private）未作成、または署名付き URL の期限切れ。マイグレーション適用とログイン状態を確認。 |
| Service Worker のキャッシュが残る | SW は本番ビルドのみ登録。`npm run dev` では無効。挙動確認は `npm run build && npm run start` で。 |
| `supabase start` が失敗する（B） | Docker Desktop が起動しているか確認。ポート競合時は既存スタックを `supabase stop`。 |

詳細なバックエンド構成・デプロイ済みプロジェクトの確認手順は [docs/supabase.md](./supabase.md) を参照してください。
