# public + Auth の暗号化原本バックアップ

`Back up database and Auth` は、Supabase の `public` と `auth` を**一回の `pg_dump -Fc`**で
取得し、その stdout を `age` の stdin へ直結する、運用担当者用の手動 workflow です。
schema と data を別々に dump しないため、両 schema のテーブルデータは同じ PostgreSQL
snapshot に属します。既定の `preserve` は読取だけです。`freeze-and-backup` は元DBへの書込を明示的に凍結し、`unfreeze` は明示的に解除します。認証設定や接続権限は変更しません。

これは移行前の原本保全と Auth import 元の取得です。**Cloud SQL へそのまま `pg_restore`
するためのファイルではありません。** Supabase の所有者・GRANT・関数・Auth内部テーブルを
含むため、移行先の明示的な schema、ユーザーID対応、許可したテーブル/列への変換、RLS試験を
別に行います。[P3/P4 の設計](../explanation/gcp-migration.md#71-ロールバックは接続先を戻すだけでは済まない)
と[移行前検証](./gcp-migration-preflight.md)も参照してください。

## 実行境界

- `godhuu0505/mfmf` の `main`、`workflow_dispatch`、production Environment のみ。
  workflow とスクリプトの双方で固定します。入力は `preserve` / `freeze-and-backup` / `unfreeze` の三択だけで、任意SQL・接続URL・relation名は受け付けません。入力は bounded event metadata から読み、raw input を環境変数やログへ展開しません。
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
  read-only設定を検証します。poolerが起動時の `PGOPTIONS` を渡さない場合に備え、probeは
  SQLで `BEGIN READ ONLY` を明示し、サーバーの実transaction状態を確認します。
  `pg_dump` 自身も [READ ONLYのsnapshot transaction](https://github.com/postgres/postgres/blob/REL_17_STABLE/src/bin/pg_dump/pg_dump.c) を開始します。
  サーバーmajorがクライアントより新しければdump前に停止します。
- DBパスワードは `PGPASSWORD` としてDB子プロセスの環境メモリだけに渡します。
  argv、URI、ファイル、age子プロセスには渡しません。PATも子プロセスへ渡しません。
  子プロセスのstderrは先頭4096bytesだけメモリで固定分類し、原文をログやファイルへ出しません。
  例外本文・DB行・ユーザーID・メール・ファイル名も出力しません。

## 成功・失敗の扱い

1. 公開recipientの検証、接続構成とCAの検証、バージョン/read-only probeを行います。
2. 初回 `preserve` は schema指定2件と `--strict-names` を付けた一回のcustom dumpをageへpipeします。
   凍結管理schemaが存在する場合は、固定の3件目 `mfmf_cutover` も同じdumpに含めます。
   パイプで流すdumpは最大1GiB、DB接続は15秒、probeのstatementは10秒、dumpのlock待ちは10秒、
   全体は20分で制限します。pg_dumpがstatement timeoutを解除するため、dump中は外側の全体期限で停止します。
3. dump/age両方の終了コード0、stream完了、custom/age header、出力サイズ・0600 permissionを
   確認後のみ、完成したciphertextを公開用ディレクトリへ排他的に作ります。
   凍結管理schemaがある場合は、dump/age完了後にも同じ厳格なread-only検証を実行し、
   初回のfrozen状態・26個のguard・20 ALWAYS/6 ORIGIN・replica回避防止条件を再確認します。
   状態変化や検証失敗があればciphertextは公開せず停止します。最終確認後の特権変更まで防ぐ仕組みではないため、
   移行中の別operator・role設定変更は禁止します。
4. 成功した場合だけ `database-auth-backup-encrypted-<run id>-<attempt>` Artifactへ
   **`database-auth.pgdump.age` 一個だけ**を90日保持します。runnerのciphertextは最後に削除します。

平文dumpをディスクへ保存しません。一時ディレクトリは0700、暗号化ファイルは0600です。
失敗、途中切断、ageエラー、上限超過では完成ファイルを公開せず非0終了します。
ログは固定stage / substage / reason enum / 許可したSQLSTATE / HTTP status数値、成功時はmajor・byte数などの集計だけです。
既存の出力ディレクトリがあれば上書きせず停止します。失敗時に手動でpartialをArtifact化しないでください。

各操作は `BEGIN READ ONLY` 内の固定catalog SELECTで、公開20表の存在・owner権限・TRIGGER権限・lock権限の件数と、
Auth6表それぞれの同じboolean、固定5ロールの `session_replication_role` SET権限を診断します。
ユーザーデータ、実所有者名、任意のrole名は出しません。`sourceCapabilities` はカタログ上の権限の報告であり、
Supabaseの管理拡張による追加許可・制限までは証明しません。owner membershipがfalseでも、この診断だけで
DDLを禁止・許可する判定には使いません。一方、AuthのORIGIN triggerを採用するためのreplica回避防止条件は
凍結・解除・状態確認で厳密に検証し、満たさなければ停止します。既定 `preserve` で書込なしに確認できます。

凍結・解除はSQLで `BEGIN READ WRITE` を明示します。失敗時はpsqlの `VERBOSITY=sqlstate` と
固定SELECTの進捗マーカーから、例として `enable-auth-users` / `42501` のような固定段階・コードだけを返します。
接続先の権限やRLSは変更しません。trigger modeの条件は下記のとおりです。コード `25006` はread-only transaction、
`42501` は権限、`55P03` はlock待ち失敗の切り分けに使えます。エラー本文・元のstdoutは出しません。
進捗の `commit` 表示はcommit成功の証拠ではありません。結果不明時は `preserve` のschema数とfrozen状態を確認し、
自動freeze再試行・自動unfreezeを行わないでください。

既定の `preserve` は`deploy-production`と直列化しますが、**アプリ・直接API・Auth操作を凍結しません**。snapshot以後の更新は含まれません。Auth/session・publicのtable dataは同一snapshotですが、
PostgreSQL sequenceの進行、別時点のStorage/GCS本体、外部OAuth設定、SMTP設定、署名鍵、
global role、extensionsなどの外部依存まで一体の復元資産になるわけではありません。
DB/Auth切替直前は下記の明示freezeとfresh snapshotに続けて、GCS世代/参照照合を行います。原本export成功は切替成功や復元成功ではありません。

## 明示的な source 凍結と解除

`freeze-and-backup` は公開schemaの固定20テーブル集合を照合し、次のAuth6表を加えた26表を
`SHARE ROW EXCLUSIVE` でlockします: `auth.users`、`auth.identities`、`auth.mfa_factors`、
`auth.mfa_recovery_code_sets`、`auth.mfa_recovery_codes`、`auth.webauthn_credentials`。
進行中DMLの終了後、private `mfmf_cutover` schema/state/guard と26個の
`BEFORE INSERT/UPDATE/DELETE/TRUNCATE` statement triggerを同じtransactionで設定します。
ロック待ちは10秒で停止し、対象tableの増減も拒否します。

public20表は `ENABLE ALWAYS`、Auth6表は作成時の `ORIGIN` modeを使います。Supabase管理Authでは
TRIGGER権限があっても `ALTER TABLE ... ENABLE ALWAYS TRIGGER` は所有者権限不足で拒否されるため、
Auth tableの所有権やGRANTを変更して迂回しません。ORIGIN modeはreplica sessionで動かないため、
この構成は次の条件を満たす場合だけ利用できます。

- PostgreSQL 17であること（guardが無い通常の原本保全は引き続き15〜17に対応）。
- 操作接続とDB/roleの既定設定がreplicaでないこと。operator接続のsession/role overrideで
  サーバー既定値が隠れている場合も、runtimeと同じだと推定せず拒否すること。
- 固定runtime/Auth5ロールと、そこから `SET ROLE` で到達できるロールが、replicaへ変更できる権限を持たないこと。
- 全26表のguard関数・trigger modeが期待どおりであること。Authの想定外modeを黙って置き換えないこと。

この検証はカタログ上の実設定に依存します。プロバイダーによるDDL制限や権限変更を受け入れたまま進めず、
作成・検証に失敗すればtransactionをロールバックして切替を止めます。
[Supabaseの管理schema制限](https://github.com/orgs/supabase/discussions/34270)はAuthの全表で任意DDLを許可するものではありません。
6表すべてへの実CREATE成功とfreeze後の完全一致確認を、本番切替の必須条件にします。

例外は `session_user` が `postgres` / `supabase_admin` のoperator接続だけです。
アプリが `SECURITY DEFINER` 関数でpostgres権限に入ってもsession_userは変わらず拒否されます。
Auth管理接続の `supabase_auth_admin` も例外にしません。guardはprivate stateを `FOR SHARE` で読み、
旧repeatable-read snapshotが凍結前のfalse状態を使う場合もserialization失敗にします。
読取とoperatorの原本dumpは維持されます。Authのログインや更新がエラーになることは、切替作業中の想定動作です。
凍結対象は上記Auth6表です。password/provider mapping、MFA要素・回復コード・WebAuthn credentialの登録/更新/削除とpublicの最終データを守りますが、
`auth.sessions` / `auth.refresh_tokens` などへの独立した内部更新まで止めません。全Auth状態が移行中ずっと固定される保証ではありません。

成功後は3schemaを一回のdumpで保全します。**freeze後にdumpや暗号化が失敗しても自動解除しません。**
固定diagnosticだけではDB commitの成否が不明な失敗もあるため、状態を確認してから同じ明示operationを再実行します。
`unfreeze` は同じtable集合・lockを確認してprivate stateをfalseへ戻すだけです。trigger/function/tableは削除せず、
archiveも作りません。GCP側で新しい書込が始まった後に、sourceを単純にunfreezeして並行稼働させてはいけません。

このguardはDDLや別の特権operatorの更新を防ぐものではありません。最終移行中は別のManagement SQL、
管理者更新、schema migrationを禁止します。担当者は通常配信workflowを一時停止し、最終import・復元検証・
固定revisionの切替とGCPモード設定が完了してから再開します。Supabase Storage本体/GCS objectや
外部IdPの状態はこのSQL transactionの対象外なので、別の照合・凍結gateが必要です。

## 復号・復元の次のgate

復号鍵はGitHubへ置かず、承認したローカルoperator環境だけで扱います。
`age --decrypt` を別の隔離検証processへpipeし、**ageと受取側の両終了コード**を検証してください。
`pg_restore --list` は内容目録を読める確認にすぎず、データの全件読み取り・restore成功ではありません。
目録やSQLをログに出さず、全archiveの読取・Auth users/identities/password hashの変換確認、
隔離DBでの許可したデータ復元、FK・RLS・認可・Google/email/passwordログインの試験が必要です。
COPY変換器へ渡す `pg_restore --data-only` 出力は `--schema=public --schema=auth` を明示し、
凍結管理schema `mfmf_cutover` を実行も変換もせず除外します。変換器はAuth全27表のCOPYを要求し、
未知・欠落・重複した表を拒否します。保持するAuthデータは `users` / `identities` です。
MFA・回復コード・WebAuthn・OAuth client/provider・SCIM・SSO・instance関連の18表は空であることを要求します。
一時セッション5表と履歴2表だけは非空でも移行対象外として明示的に破棄し、暗号化原本は保全します。
非対応認証データを黙って無視して移行を完了させません。
復号済み原本をCloud SQL本番や稼働Supabaseへ直接実行しないでください。

## オフライン検証

```sh
node --test tests/scripts/backup-database-auth.test.mjs
# tests/gcp/run-db-tests.py が作る固定test imageを利用する隔離fixture
node tests/scripts/source-database-cutover-local.mjs
```

実通信・実DB接続を使わず、実際に起動する架空子プロセスでsingle dump、環境変数分離、
途中非0終了、broken pipe、上限、timeout、version mismatch、CA mismatch、固定診断、
ファイルの非公開/排他作成・明示freeze・失敗時の凍結維持を検証します。workflowでも秘密を渡す前にこの試験を実行します。
隔離PostgreSQL fixtureはnetwork none/tmpfs/ランダムcontainerで、全表DML、Auth管理role、SECURITY DEFINER、
旧repeatable-read transactionの拒否、operator dump、stateだけの解除を実際に検証し、containerを削除します。
Auth6表のORIGIN guard、replica設定/到達可能roleの拒否、guard数やmodeの不一致も失敗として確認します。

一次資料:

- [PostgreSQL 17 pg_dump — consistent snapshot / client compatibility / schema selection](https://www.postgresql.org/docs/17/app-pgdump.html)
- [PostgreSQL 17 CREATE TRIGGER privileges](https://www.postgresql.org/docs/17/sql-createtrigger.html)
- [PostgreSQL 17 ALTER TABLE ownership](https://www.postgresql.org/docs/17/sql-altertable.html)
- [PostgreSQL session_replication_role とtrigger実行](https://www.postgresql.org/docs/17/runtime-config-client.html#GUC-SESSION-REPLICATION-ROLE)
- [Supabase session poolerでのbackup](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore)
- [Supabase Pooler Management API](https://supabase.com/docs/reference/api/v1-get-pooler-config)
- [Supabase session modeは5432](https://supabase.com/kb/troubleshooting/how-do-i-update-connection-pool-settings-in-my-dashboard-wAxTJ_)
- [Supabase TLSとverify-full](https://supabase.com/docs/guides/database/psql)
- [Supabase公開Root CA](https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt)
- [GitHub Ubuntu runnerのPostgreSQL APT source](https://github.com/actions/runner-images/blob/main/README.md#software-and-image-support)
