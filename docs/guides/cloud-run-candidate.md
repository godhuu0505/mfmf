# Cloud Run 候補イメージの準備

Actions の **Prepare Cloud Run Candidate** を main から手動実行すると、
Vercel production の設定を読み、東京の Artifact Registry `mfmf` に
`mfmf-candidate` イメージを push します。Cloud Run の作成・公開・トラフィック変更や
Supabase migration は実行しません。初回の private サービス作成は別途行います。

## 前提

- `Dockerfile.cloudrun` によるコンテナ検証が CI で成功していること。
- GitHub production Environment の既存 secrets:
  `VERCEL_TOKEN` / `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID`。
- GitHub variables: `GCP_WIF_PROVIDER` / `GCP_DEPLOY_SERVICE_ACCOUNT` / `GCP_PROJECT_ID` / `GCP_PROJECT_NUMBER`。
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

Vercel の公式 `GET /v10/projects/{project}/env?teamId=...` から production の明示的な
allowlist だけを選び、各 ID の `GET /v1/projects/{project}/env/{id}?teamId=...`
（decrypted value endpoint）で平文を取得します。list の `value` や deprecated な
`decrypt` query には依存しません。preview / ブランチ固有設定は使いません。
必須設定不足、重複、非平文・未復号値、非表示または途中までの一覧は変更前に失敗させます。
Sensitive 型など API から読めない値は管理者が安全な保管元から別途移す必要があり、
この処理で新しい暗号鍵を生成したり、実 env ファイルへフォールバックすることはありません。
個別応答の key / type / ID / production scope を照合し、value 欠落や encrypted かつ
`decrypted:false` は拒否します。専用 endpoint の公式 schema は `decrypted` 省略の
`value:string` variant も持つため、この場合は endpoint の平文取得契約に従います。
拒否時の診断は allowlist の変数名・固定 type 分類・decrypted の有無/型・value の型と
公開キーの分類だけであり、応答本文や値は出力しません。

設定の型が原因で停止したら `Inspect Vercel Environment Metadata` を main から手動実行します。
production 環境の既存 Vercel 資格情報で一覧を GET 1回だけ読み、移行対象9キーの
type / visibility、scope、decrypted の有無・型、value の有無・型、旧 secret 移行印の有無を
固定分類として表示します。任意の値・ID・ブランチ名・応答本文は表示せず、ファイルや
artifact にも保存しません。prepare の読み取り制限は変更しません。

Vercel は 2026-08-24 から Config / Secret を区別し、旧 Sensitive は Secret として扱います。
Secret は deployment が使用できますが、保存後の値を member が取得することはできません。
この型が確認された場合は元のパスワード管理等の保管元から、安全に Secret Manager の既存
対象へ新しい version を入力する手順を別途確認します。アプリの一時ルートやログで Vercel の
読み取り制限を迂回しません。特に `TOKEN_ENC_KEY` は既存の暗号化データに必要なため、
新しい鍵を生成して置き換えないでください。

## 事前登録した固定バージョンを使う場合

管理者が元の値を Secret Manager へ直接登録し、対象 version の存在と `ENABLED` を確認した後、
手動実行の `preseeded_secret_versions` に非秘密の参照 JSON を渡せます。許可するキーは
`TOKEN_ENC_KEY` / `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` の3つだけです。
設定していないキーは従来の Vercel 個別取得 → `addVersion` 経路を使用し、
読み取れない型が残っていれば転送前に停止します。
入力を step の env 欄へ展開せず、Node CLI が既存の `GITHUB_EVENT_PATH` から
メモリ内へ読みます（64 KiB 上限、参照 JSON は4 KiB 上限）。壊れた JSON や誤入力も
stdout / stderr へ出しません。実 env ファイルを読んだり、新しい秘密ファイルを作ったりしません。

```json
{
  "TOKEN_ENC_KEY": "projects/mfmf-499612/secrets/mfmf-token-enc-key/versions/1",
  "GOOGLE_CLIENT_ID": "projects/mfmf-499612/secrets/mfmf-google-client-id/versions/1",
  "GOOGLE_CLIENT_SECRET": "projects/mfmf-499612/secrets/mfmf-google-client-secret/versions/1"
}
```

例の version `1` は**管理者が確認した実際の番号へ置き換えます**。project は設定済み
`GCP_PROJECT_ID` または `GCP_PROJECT_NUMBER` と完全一致、secret 名は上表の固定名、
version は正整数のみです。別 project、別 secret、`latest`、余分なキーは拒否します。
指定した参照に対応する本番 metadata が存在しない・重複する・scope/type が不明な場合も拒否します。
Google は本番 metadata に ID / secret の両方が必要です。preview の値へ切り替えません。

指定項目は Vercel の復号 API も Secret Manager の `addVersion` も呼びません。
値の取得・比較・代替値の生成はせず、確認済みの参照を manifest にそのまま固定します。
この workflow は SecretVersion の読取権限を持たないため、存在/状態/元値の確認は
実行前の管理者の作業です。deploy SA に追加の読取権限は不要です。

## 認証URLの診断

認証の戻り先設定は **Actions → Inspect Supabase Auth URLs → Run workflow（main）** で参照できます。
既存 production secrets の `SUPABASE_ACCESS_TOKEN` / `SUPABASE_PROJECT_ID` を使用し、
Management API の `GET /v1/projects/{ref}/config/auth` を1回だけ実行します。
出力は `site_url` / カンマ区切りの `uri_allow_list` の origin と、既知の認証用 pathname・
一般的な wildcard pathname に限定します。それ以外のパス、userinfo、query/hash の値、
SMTP/OAuth 設定や応答本文は表示・保存しません。応答は256 KiB、一覧は200項目までです。
これは表示用の要約であり、`?` も glob として使えるため実際の許可判定は行いません。
null と空の URL は `not-configured` にまとめるため、生の設定値の厳密比較にも使いません。
`pattern-unverified` や伏せた項目を、対象 callback の許可確認済みと解釈しないでください。
設定変更・復帰・migration・デプロイは行わず、本番配信の concurrency group も使いません。
仕様: [Auth config API](https://supabase.com/docs/reference/api/v1-get-auth-service-config)、
[Redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls)。

## ビルドと出力

Docker build args は `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` と
公開の正規 boolean `SIGNUP_ENABLED` だけ。login / signup の静的生成時にも同じ flag を渡し、
既存の登録導線を保持します。flag を変更するときは実行時設定だけでなくイメージも再ビルドします。
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
- 追加または事前登録した SecretVersion の完全な名前（数値 version を固定。`latest` は使わない）

初回 private Cloud Run の作成では、この artifact の digest と固定 SecretVersion を使います。
候補サービスの起動後にログイン・招待・閲覧・作成・写真・権限の確認を終えるまで公開しません。

公式仕様:
[Vercel project env API](https://vercel.com/docs/rest-api/projects/retrieve-the-environment-variables-of-a-project-by-id-or-name)、
[Vercel decrypted value API](https://vercel.com/docs/rest-api/projects/retrieve-the-decrypted-value-of-an-environment-variable-of-a-project-by-id)、
[Vercel Config / Secret の変更](https://vercel.com/changelog/environment-variables-now-use-config-and-secret-types)、
[Secret Manager addVersion](https://cloud.google.com/secret-manager/docs/reference/rest/v1/projects.secrets/addVersion)、
[GitHub Actions WIF](https://github.com/google-github-actions/auth)、
[Artifact Registry の認証](https://cloud.google.com/artifact-registry/docs/docker/authentication)。
