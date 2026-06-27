# ローカル Supabase スタックを立てる

スキーマやマイグレーションを安全に試したいときに、Supabase CLI で**ローカルに Supabase 一式**を
起動する手順です。Docker が必要です。リモート Supabase に繋ぐ通常手順は
[getting-started.md](../getting-started.md) を参照してください。

## 前提ツール

| ツール | バージョン目安 | 用途 |
| --- | --- | --- |
| Docker Desktop | 任意 | Supabase ローカルスタック |
| Supabase CLI | 任意 | スタック起動・マイグレーション |

## 1. Supabase CLI を用意

```bash
# macOS (Homebrew)
brew install supabase/tap/supabase
# それ以外は npm 経由でも可
npm install -g supabase

supabase --version
```

## 2. ローカルスタックを起動

リポジトリ直下（`supabase/` がある場所）で実行します。このリポジトリは
`supabase/migrations/` のみを追跡し `supabase/config.toml` を含まないため、
**初回は `supabase init` で config を生成**してから `supabase start` します。

```bash
supabase init   # config を生成（既にあればスキップ／エラーになるだけで無害）
supabase start
```

初回は Docker イメージ取得に数分かかります。完了すると **API URL** / **anon key** /
**Studio URL** が出力されます。`supabase/migrations/` 配下は起動時に自動適用されます。

> いつでも `supabase status` で接続情報を再表示できます。
> ローカル Studio（http://localhost:54323 付近）でテーブルやユーザーを確認できます。

## 3. 環境変数をローカルスタックに向ける

`supabase start` / `supabase status` の出力値を `.env.local` に設定します。

```dotenv
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<supabase status が表示する anon key>
```

## 4. ログイン用ユーザーを発行して起動

ローカル Studio の **Authentication > Users**（または CLI）でユーザーを作成し、起動します。
**共有する 1 アカウント**を発行して 2 人で使います。

```bash
npm run dev      # http://localhost:3000 でローカルスタックに繋がる
supabase stop    # 終了時にスタックを停止
```

---

## トラブルシュート

| 症状 | 原因 / 対処 |
| --- | --- |
| 起動時に `NEXT_PUBLIC_SUPABASE_URL` 関連でエラー | `.env.local` 未設定 / 値が空。`.env.local.example` を元に設定し `npm run dev` を再起動。 |
| ログインできない | ユーザー未発行、または email/password 間違い。ダッシュボード（or Studio）の Authentication > Users を確認。 |
| 一覧は出るが他人のデータが見える / 見えない | RLS が `owner_id = auth.uid()` 前提。マイグレーション未適用の可能性。`supabase/migrations/` を再適用。 |
| 写真が表示されない | Storage バケット `daycare-photos`（private）未作成、または署名付き URL の期限切れ。マイグレーション適用とログイン状態を確認。 |
| Service Worker のキャッシュが残る | SW は本番ビルドのみ登録。`npm run dev` では無効。挙動確認は `npm run build && npm run start` で。 |
| `supabase start` が失敗する | Docker Desktop が起動しているか確認。ポート競合時は既存スタックを `supabase stop`。 |

関連: [reference/architecture.md](../reference/architecture.md) ・ [guides/verify-backend.md](./verify-backend.md)
