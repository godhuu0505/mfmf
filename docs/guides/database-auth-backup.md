# public + Auth の暗号化原本バックアップ

`Back up database and Auth` は、Supabase の `public` と `auth` を**一回の `pg_dump -Fc`**で
取得し、その stdout を `age` の stdin へ直結する、運用担当者用の手動 workflow です。
schema と data を別々に dump しないため、両 schema のテーブルデータは同じ PostgreSQL
snapshot に属します。アプリや認証設定、元DBの行、接続権限は変更しません。

これは移行前の原本保全と Auth import 元の取得です。**Cloud SQL へそのまま `pg_restore`
するためのファイルではありません。** Supabase の所有者・GRANT・関数・Auth内部テーブルを
含むため、移行先の明示的な schema、ユーザーID対応、許可したテーブル/列への変換、RLS試験を
別に行います。[P3/P4 の設計](../explanation/gcp-migration.md#71-ロールバックは接続先を戻すだけでは済まない)
と[移行前検証](./gcp-migration-preflight.md)も参照してください。

## 実行境界

- `godhuu0505/mfmf` の `main`、`workflow_dispatch`、production Environment のみ。
  workflow とスクリプトの双方で固定し、入力パラメータや任意の接続URLは受け付けません。
- source project は `aqvmuhqkaqedtxuqwhoq` 固定です。既存の `SUPABASE_PROJECT_ID` と照合します。
- 既存の `SUPABASE_ACCESS_TOKEN` は、その project の Management API pooler config **GETのみ**に使用します。
  APIキーや `service_role` を取得しません。HTTP redirect は拒否し、エラー本文も読みません。
- 返却された PRIMARY の Supavisor host を許可形式・DB名・ユーザー名・port/modeで検証し、
  一意の host の **session port 5432** に接続します。transaction port 6543 でdumpしません。
  APIの接続URIは利用せず、`postgres.<固定ref>` / `postgres` を組み立てます。
- Supabase公開Root CAを固定HTTPS URLから取得し、SHA-256一致後だけ利用します。
  `sslmode=verify-full` とTLS 1.2以上を指定し、CA/hostnameエラー時のSSL弱化はしません。
  これはclient→poolerの検証です。pooler→DBの経路設定をこのworkflowは変更しません。
- Ubuntu 24.04で `postgresql-client-17` を明示導入し、`/usr/lib/postgresql/17/bin/` の
  `psql` / `pg_dump` のmajorを検証します。17系の修正パッチは追従します。
  接続後にサーバーmajorが15〜17、接続roleがpostgresかつRLS bypass、DB名、Auth表の存在と
  read-only設定を検証します。サーバーmajorがクライアントより新しければdump前に停止します。
- DBパスワードは `PGPASSWORD` としてDB子プロセスの環境メモリだけに渡します。
  argv、URI、ファイル、age子プロセスには渡しません。PATも子プロセスへ渡しません。
  全子プロセスのstderrを破棄し、例外本文・DB行・ユーザーID・メール・ファイル名をログに出しません。

## 成功・失敗の扱い

1. 公開recipientの検証、接続構成とCAの検証、バージョン/read-only probeを行います。
2. schema指定2件と `--strict-names` を付けた一回のcustom dumpをageへpipeします。
   パイプで流すdumpは最大1GiB、DB接続は15秒、各statementは10分、全体は20分で制限します。
3. dump/age両方の終了コード0、stream完了、custom/age header、出力サイズ・0600 permissionを
   確認後のみ、完成したciphertextを公開用ディレクトリへ排他的に作ります。
4. 成功した場合だけ `database-auth-backup-encrypted-<run id>-<attempt>` Artifactへ
   **`database-auth.pgdump.age` 一個だけ**を90日保持します。runnerのciphertextは最後に削除します。

平文dumpをディスクへ保存しません。一時ディレクトリは0700、暗号化ファイルは0600です。
失敗、途中切断、ageエラー、上限超過では完成ファイルを公開せず非0終了します。
ログは固定stage / HTTP status数値、成功時はmajor・byte数などの集計だけです。
既存の出力ディレクトリがあれば上書きせず停止します。失敗時に手動でpartialをArtifact化しないでください。

このworkflowは`deploy-production`と直列化しますが、**アプリ・直接API・Auth操作を凍結しません**。
snapshot以後の更新は含まれません。Auth/session・publicのtable dataは同一snapshotですが、
PostgreSQL sequenceの進行、別時点のStorage/GCS本体、外部OAuth設定、SMTP設定、署名鍵、
global role、extensionsなどの外部依存まで一体の復元資産になるわけではありません。
DB/Auth切替直前には、直接APIとアカウント更新を含む書込停止・進行中処理のdrain・fresh snapshot・
GCS世代/参照照合を別のgateで行います。原本export成功は切替成功や復元成功ではありません。

## 復号・復元の次のgate

復号鍵はGitHubへ置かず、承認したローカルoperator環境だけで扱います。
`age --decrypt` を別の隔離検証processへpipeし、**ageと受取側の両終了コード**を検証してください。
`pg_restore --list` は内容目録を読める確認にすぎず、データの全件読み取り・restore成功ではありません。
目録やSQLをログに出さず、全archiveの読取・Auth users/identities/password hashの変換確認、
隔離DBでの許可したデータ復元、FK・RLS・認可・Google/email/passwordログインの試験が必要です。
復号済み原本をCloud SQL本番や稼働Supabaseへ直接実行しないでください。

## オフライン検証

```sh
node --test tests/scripts/backup-database-auth.test.mjs
```

実通信・実DB接続を使わず、実際に起動する架空子プロセスでsingle dump、環境変数分離、
途中非0終了、broken pipe、上限、timeout、version mismatch、CA mismatch、固定診断、
ファイルの非公開/排他作成を検証します。workflowでも秘密を渡す前にこの試験を実行します。

一次資料:

- [PostgreSQL 17 pg_dump — consistent snapshot / client compatibility / schema selection](https://www.postgresql.org/docs/17/app-pgdump.html)
- [Supabase session poolerでのbackup](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore)
- [Supabase Pooler Management API](https://supabase.com/docs/reference/api/v1-get-pooler-config)
- [Supabase session modeは5432](https://supabase.com/kb/troubleshooting/how-do-i-update-connection-pool-settings-in-my-dashboard-wAxTJ_)
- [Supabase TLSとverify-full](https://supabase.com/docs/guides/database/psql)
- [Supabase公開Root CA](https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt)
- [GitHub Ubuntu runnerのPostgreSQL APT source](https://github.com/actions/runner-images/blob/main/README.md#software-and-image-support)
