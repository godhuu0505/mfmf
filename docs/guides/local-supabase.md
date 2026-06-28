# ローカル Supabase スタックを立てる

スキーマやマイグレーションを安全に試したいときに、Supabase CLI で**ローカルに Supabase 一式**を
起動する手順です。Docker が必要です。リモート Supabase に繋ぐ通常手順は
[getting-started.md](../getting-started.md) を参照してください。

## 前提ツール

| ツール | バージョン目安 | 用途 |
| --- | --- | --- |
| Docker ランタイム | 任意 | Docker Desktop / Rancher Desktop（dockerd ランタイム）など |
| Supabase CLI | 任意 | スタック起動・マイグレーション |
| `just` | 任意 | `just setup` / `just up` を使う場合 |

> Rancher Desktop を使う場合は **Preferences > Container Engine** で
> **`dockerd (moby)`** を選択してください（`containerd` だと `docker` CLI が動きません）。
> 必要に応じて `~/.zshrc` に `export PATH="$HOME/.rd/bin:$PATH"` /
> `export DOCKER_HOST="unix://$HOME/.rd/docker.sock"` を追加します。

## 1. ツールを用意

```bash
# macOS (Homebrew)
brew install supabase/tap/supabase just
# Supabase CLI は npm 経由でも可だが Homebrew 推奨
supabase --version
just --version
```

## 2. `supabase/config.toml` を生成（初回のみ）

リポジトリは `supabase/migrations/` のみを追跡し `config.toml` を含みません：

```bash
supabase init   # config を生成（既にあればスキップ／エラーになるだけで無害）
```

## 3. `just setup` で初回構築（推奨）

`just setup` が **Supabase の起動・`.env.local` の生成・URL/anon key の自動投入**をまとめて行います。
**`.env.local` 未作成の状態で 1 回だけ**実行してください。

```bash
just setup
```

実行内容：

1. `supabase status` が失敗（未起動）なら `supabase start` を実行
2. `.env.local.example` を `.env.local` にコピー
3. `supabase status -o env` から `ANON_KEY` を取得して `.env.local` に書き込む
4. `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321` を投入

`.env.local` が既に存在する場合は abort します（誤上書き防止）。手動でやり直したい場合は
`rm .env.local` してから再実行してください。

> 手動でやる場合は `supabase start` 後、`supabase status` の値を `.env.local` に書きます：
> ```dotenv
> NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
> NEXT_PUBLIC_SUPABASE_ANON_KEY=<supabase status の anon key>
> ```

## 4. Google ログインを設定

本アプリは **Google OAuth 一本化**で、メール/パスワードログインの UI はありません。
ローカル Supabase でログインするには Google Cloud の OAuth クライアントを発行し、
`supabase/config.toml` の `[auth.external.google]` を有効化する必要があります。

手順は **[google-drive-setup.md](./google-drive-setup.md)** を参照（ローカル向け
redirect URI と `config.toml` 例は「2B. ローカル Supabase の場合」セクション）。
`.env.local` 側では `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` を設定します。
`TOKEN_ENC_KEY` は `just setup` が自動で乱数を投入します。

> ⚠️ 夫婦共用方針：RLS が `owner_id = auth.uid()` のため、別の Google アカウントで
> ログインすると記録が共有されません。**1 つの Google アカウント**で 2 人とも使ってください。

## 5. アプリ起動

```bash
just dev        # ホスト Node で next dev
# または
just up         # docker compose で Next.js をコンテナ起動（CI と同じ Node 22）
```

終了時：

```bash
just down       # コンテナを停止（just up を使った場合）
supabase stop   # Supabase スタックを停止（データは保持）
```

## なぜ `just up` でもローカル Supabase に繋がるのか

`just up` の Next.js コンテナからホストの `127.0.0.1:54321` には届きません。代わりに
`SUPABASE_INTERNAL_URL=http://host.docker.internal:54321` を `docker-compose.yml` の
`environment` で渡し、SSR/middleware 側（`src/lib/supabase/server.ts` /
`src/lib/supabase/middleware.ts`）でこの値を優先利用します。ブラウザは従来通り
`NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321` を使うため `/etc/hosts` の変更は不要です。

`just dev`（ホスト Node）の場合は `SUPABASE_INTERNAL_URL` が未設定で
`NEXT_PUBLIC_SUPABASE_URL` にフォールバックします。

---

## トラブルシュート

| 症状 | 原因 / 対処 |
| --- | --- |
| `just setup` が `.env.local already exists` | 初回専用。再構築したいなら `rm .env.local` してから（既存値は事前にメモ） |
| `just setup` が `Failed to read ANON_KEY` | `supabase start` 完了前。`supabase status` で起動を確認してから再実行 |
| 起動時に `NEXT_PUBLIC_SUPABASE_URL` 関連でエラー | `.env.local` 未設定 / 値が空。`just setup` 実行か、`.env.local.example` を元に設定し再起動 |
| Google ログインができない | `supabase/config.toml` の `[auth.external.google]` 設定漏れ、`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` 未設定、または Google Cloud 側のリダイレクト URI に `http://127.0.0.1:54321/auth/v1/callback` が登録されていない可能性 |
| 一覧は出るが他人のデータが見える / 見えない | RLS が `owner_id = auth.uid()` 前提。マイグレーション未適用の可能性 |
| 写真が表示されない | Storage バケット `daycare-photos`（private）未作成、または署名付き URL の期限切れ |
| `just up` で SSR が Supabase に届かない | `docker-compose.yml` の `environment.SUPABASE_INTERNAL_URL` と `extra_hosts` を確認 |
| Service Worker のキャッシュが残る | SW は本番ビルドのみ登録。`just dev` / `just up` では無効。挙動確認は `npm run build && npm run start` |
| `supabase start` が失敗する | Docker ランタイムが起動しているか確認。ポート競合時は既存スタックを `supabase stop` |
| `docker: command not found` (Rancher Desktop) | Container Engine を `dockerd (moby)` に変更、`PATH` に `~/.rd/bin` を追加 |

関連: [reference/architecture.md](../reference/architecture.md) ・ [guides/verify-backend.md](./verify-backend.md)
