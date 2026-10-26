# Cloud Run 候補イメージの準備

Actions の **Prepare Cloud Run Candidate** を main から手動実行すると、
Vercel production の設定を読み、東京の Artifact Registry `mfmf` に
`mfmf-candidate` イメージを push します。Cloud Run の作成・公開・トラフィック変更や
Supabase migration は実行しません。初回の private サービス作成は別途行います。

## 前提

- `Dockerfile.cloudrun` によるコンテナ検証が CI で成功していること。
- GitHub production Environment の既存 secrets:
  `VERCEL_TOKEN` / `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID`。
- GitHub variables: `GCP_WIF_PROVIDER` / `GCP_DEPLOY_SERVICE_ACCOUNT` / `GCP_PROJECT_ID`。
- WIF の信頼先は、このリポジトリの main / `deploy-cloud-run.yml` に限定する。
- Artifact Registry `mfmf`（`asia-northeast1`）を事前作成し、deploy SA に当該 repository の writer を付ける。
- 次の Secret Manager containers を事前作成し、deploy SA に対象ごとの
  `roles/secretmanager.secretVersionAdder`、runtime SA に対象ごとの accessor を付ける。
  この workflow に secret の作成・読取・削除権限は不要。

| Vercel の production 設定 | Secret Manager 名 | 必須 |
| --- | --- | --- |
| `TOKEN_ENC_KEY` | `mfmf-token-enc-key` | 必須。既存の値をそのまま保持する |
| `GOOGLE_CLIENT_ID` | `mfmf-google-client-id` | Drive 連携使用時。secret とペアで必須 |
| `GOOGLE_CLIENT_SECRET` | `mfmf-google-client-secret` | Drive 連携使用時。ID とペアで必須 |
| `SENTRY_DSN` | `mfmf-sentry-dsn` | 任意。空なら version 追加・実行時参照を省略 |

## 実行結果と失敗時

Vercel の公式 `GET /v10/projects/{project}/env?decrypt=true&teamId=...` から
production の明示的な allowlist だけを選びます。preview / ブランチ固有設定は使いません。
必須設定不足、重複、非平文・未復号値、非表示または途中までの一覧は変更前に失敗させます。
Sensitive 型など API から読めない値は管理者が安全な保管元から別途移す必要があり、
この処理で新しい暗号鍵を生成したり、実 env ファイルへフォールバックすることはありません。

Docker build args は `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` と
公開の正規 boolean `SIGNUP_ENABLED` だけ。login / signup の静的生成時にも同じ flag を渡し、
既存の登録導線を保持します。
URL は hosted Supabase の HTTPS URL、キーは anon JWT / publishable key に限定し、
`service_role` / secret key を拒否します。カスタム Supabase ドメインは未対応です。
サーバーの値はメモリから Secret Manager の `addVersion` API へ直接渡します。
Docker の子プロセスにもサーバーの値を渡しません。

WIF は短期 access token を使い、認証ファイルやサービスアカウント鍵を作りません。
Docker 認証は固定 registry だけに答える credential helper の pipe 経由とし、
`docker login` の認証情報ファイルを作りません。API 応答本文・Docker 出力・例外の内容は
ログへ流しません。失敗した API 要求は自動再送せず、後続処理と artifact 作成を止めます。
途中失敗で追加済み SecretVersion が残ることはありますが、サービスの参照は変更しません。

成功時だけ `cloud-run-candidate-public-<sha>-<attempt>` artifact を保存します。
`candidate-public.json` には次の公開設定と参照だけが入り、秘密の値は入りません。

- push 済みイメージの固定 digest、region `asia-northeast1`、service `mfmf-candidate`
- Supabase 公開設定と `SIGNUP_ENABLED` / `SENTRY_ENVIRONMENT` / `SENTRY_TRACES_SAMPLE_RATE`
- Drive / Sentry の設定有無だけを示す `features`（秘密の値は出さない）
- 追加した SecretVersion の完全な名前（数値 version を固定。`latest` は使わない）

初回 private Cloud Run の作成では、この artifact の digest と固定 SecretVersion を使います。
候補サービスの起動後にログイン・招待・閲覧・作成・写真・権限の確認を終えるまで公開しません。

公式仕様:
[Vercel project env API](https://vercel.com/docs/rest-api/projects/retrieve-the-environment-variables-of-a-project-by-id-or-name)、
[Secret Manager addVersion](https://cloud.google.com/secret-manager/docs/reference/rest/v1/projects.secrets/addVersion)、
[GitHub Actions WIF](https://github.com/google-github-actions/auth)、
[Artifact Registry の認証](https://cloud.google.com/artifact-registry/docs/docker/authentication)。
