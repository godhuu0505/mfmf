# 環境変数・コマンド・リファレンス

## 環境変数

設定例は [`.env.local.example`](../../.env.local.example) を参照。実 env ファイル（`.env.local` 等）は
コミットしないこと。

### アプリ本体（必須）

| 変数 | 取得元（Supabase） | 使う場所 |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Project Settings > API > Project URL | ローカル `.env.local` / Vercel 環境変数 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Project Settings > API > anon / publishable key | ローカル `.env.local` / Vercel 環境変数 |

> `NEXT_PUBLIC_*` はブラウザに公開される前提の値。RLS でデータを保護しているため公開しても問題ない。
> `service_role` キーはサーバー専用の特権鍵で、本アプリでは**使わず**、リポジトリ・クライアントにも置かない。

### Google Drive 連携（必須）

Google ログインと写真の Drive 保存に使う。設定手順は
[guides/google-drive-setup.md](../guides/google-drive-setup.md)。いずれも **サーバー専用**
（`NEXT_PUBLIC_` を付けない）。Vercel の環境変数とローカル `.env.local` の両方に設定する。

| 変数 | 取得元 | 用途 |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | Google Cloud の OAuth クライアント | refresh token → access token 発行 |
| `GOOGLE_CLIENT_SECRET` | 同上（Supabase の Google プロバイダにも設定） | 同上 |
| `TOKEN_ENC_KEY` | 自分で生成した長い乱数文字列 | refresh token を DB 保存前に暗号化する鍵 |

> `TOKEN_ENC_KEY` を失うと保存済みの Drive 連携を復号できなくなる（各自で再ログインが必要）。
> `GOOGLE_CLIENT_SECRET` は Supabase ダッシュボードの Google プロバイダ設定にも同じ値を入れる。

### フィードバック Issue 化スクリプト（運用時のみ）

`scripts/feedback-to-issues.mjs` を手元で実行するときだけ必要。詳細は
[guides/feedback-to-issues.md](../guides/feedback-to-issues.md)。

| 変数 | 用途 |
| --- | --- |
| `FEEDBACK_USER_EMAIL` / `FEEDBACK_USER_PASSWORD` | 夫婦共用ログイン（RLS 経由で `feedback` を取得） |
| `GITHUB_TOKEN` | Issues 書き込み権の Fine-grained PAT |
| `GITHUB_FEEDBACK_REPO` | 登録先 `owner/repo`（★ 必ず非公開リポジトリ） |

### デプロイ（GitHub Secrets）

CI/CD で使用。詳細は [guides/deploy.md](../guides/deploy.md)。`preview` / `production` の両 Environment に
登録する。Supabase 系 3 つは値が同じ（同一プロジェクト共有）。

| Secret | 用途 | 取得元 |
| --- | --- | --- |
| `VERCEL_TOKEN` | Vercel デプロイ | Vercel Account Settings > Tokens |
| `VERCEL_ORG_ID` | Vercel デプロイ | `.vercel/project.json` の `orgId` |
| `VERCEL_PROJECT_ID` | Vercel デプロイ | `.vercel/project.json` の `projectId` |
| `SUPABASE_ACCESS_TOKEN` | DB migrate / dump | Supabase Dashboard > Account > [Access Tokens](https://supabase.com/dashboard/account/tokens) |
| `SUPABASE_DB_PASSWORD` | DB migrate / dump | Supabase Dashboard > Project Settings > Database |
| `SUPABASE_PROJECT_ID` | DB migrate / dump | Project URL の subdomain（20 文字英小文字） |

> Supabase 系が未設定なら `migrate` ジョブは自動 skip され、Vercel deploy のみ走る（DB に触らない
> 動作確認用の抜け道）。Vercel 系が未設定なら deploy 全体 skip。

## npm スクリプト

| コマンド | 内容 |
| --- | --- |
| `npm run dev` | 開発サーバー（http://localhost:3000） |
| `npm run build` | 本番ビルド |
| `npm run start` | 本番ビルドの起動 |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` による型チェック |
| `npm run icons` | PWA アイコンを再生成（`scripts/generate-icons.mjs`） |
| `npm run feedback:issues` | フィードバックをマスクして非公開リポに Issue 化 |

> 変更後は `npm run lint` と `npm run typecheck` を必ず通す。UI / ルーティング / ビルド構成を
> 触ったときは `npm run build` も確認する（CI と同じゲート。`.github/workflows/ci.yml`）。
