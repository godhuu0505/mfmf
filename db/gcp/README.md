# GCP の DB ベースラインと認証ミラー

このディレクトリは **新しい空の Cloud SQL PostgreSQL 17** 用の候補です。
既存 Supabase へ適用しません。Cloud SQL への実適用・本番データの復元・認証切替はまだ行っていません。
既存 `supabase/migrations/` は変更せず、現在の RLS と RPC を別の所有者・認証方式へ移します。

## 適用する主体

| ロール | 用途 / 許可 |
| --- | --- |
| `mfmf_owner` | NOLOGIN、スキーマと SECURITY DEFINER 関数の所有者。SUPERUSER/BYPASSRLS なし |
| `mfmf_migrator` | NOINHERIT LOGIN。明示的に owner へ SET ROLE して初期化・復元する。実行時アプリには渡さない |
| `authenticator` | NOINHERIT LOGIN。SET ROLE は `anon` / `authenticated` / `identity_sync` のみ |
| `identity_sync` | 検証済み IdP identity を同期する RPC だけ。業務テーブル・auth.users の直接操作不可 |
| `media_operator` / `mfmf_operator` | 画像管理専用ロール / その LOGIN。ユーザー JWT があるセッションは operator 判定に失敗する |

`000_roles.sql` は provisioning administrator が一度だけ実行します。既存ロールは再利用せずエラーにします。
認証パスワードや IAM principal は SQL に含めません。対象 DB の `public` 所有権と extension の作成権限が必要です。
以後は `mfmf_migrator` で接続して `SET ROLE mfmf_owner` を実行し、
`010_identity.sql` → `020_public.sql` → `030_permissions.sql` を一つのトランザクションで適用します。
`pg_trgm` 以外の Supabase platform extension や `storage` schema は不要です。

すべての実行時ロールは NOSUPERUSER/NOBYPASSRLS。`public` CREATE、TRUNCATE、auth mirror の直接参照、
管理ロールへの昇格を許可しません。通常の DML は元の行 RLS を通ります。
元のランキング予算テーブルの FORCE RLS を残し、関数所有者 `mfmf_owner` にだけ policy を付けます。
これにより元環境の superuser bypass への依存を取り除き、利用者にカウンターを書き換える権限を渡しません。

## 認証の境界

`sync_identity(p_subject text, p_email text, p_email_verified boolean, p_allow_create boolean DEFAULT false) RETURNS uuid` は `identity_sync` のみ実行できます。
Next が Identity Platform token の署名・audience・失効を検証した後、内部の短命 JWT で呼び出します。
PostgREST は loopback のみ公開し、外部から JWT / role / subject を直接渡せるプロキシを作りません。
RPC 自身は IdP を問い合わせません。このロールや内部 JWT 署名鍵を外部へ渡してはいけません。
新 subject の作成は既定で拒否します。`p_allow_create` はサーバーの登録設定だけから決め、HTTP 入力を使いません。
IdP 側が新規アカウントを作成済みでも、閉じた設定では初回・二回目とも mapping のない subject を拒否します。

`auth.users` は内部 UUID・IdP subject・検証済みメールだけのミラーです。メールによるアカウント結合はしません。
未検証メールは NULL。既存ユーザーはインポート時に `id = 元 UUID`、`provider_subject = 移行先 IdP UID` を
明示的に INSERT します。元 UUID 形式の subject に未設定の元ユーザーがある場合、初回ログインで取り込まず拒否します。
id/subject は更新不能です。同じ subject / email / verified の同期は行 lock のみで既存 UUID を返し、updated_at を含め一切更新しません。
このため import 済みユーザーは frozen 候補にもログインできます。メール確認状態やメール値の変更、新規追加は実書込なので freeze に拒否されます。インポート完了 gate では全対象ユーザーの明示 mapping と IdP 側 UID の一致を確認します。
このミラーはパスワード、Google provider identity、回復 token、IdP 設定のバックアップの代わりではありません。

`auth.uid()` / `jwt()` / `role()` は PostgREST の transaction-local `request.jwt.claims` だけを読みます。
以前の scalar GUC の sub は読みません。transaction 終了後に claims が残らないことを実 LOGIN 接続で検証します。

## 画像と復元

初期 `media_storage_state` は `frozen / gcs`。Supabase backend は選べません。
operator の private ledger は全体書込 state も frozen で作り、全 public 20 表と auth.users の DML / TRUNCATE を止めます。
GCS 台帳の generation、参照元 ID、旧移行情報、削除 tombstone を保持します。
ready 台帳は利用者の申告であり、GCS 実物の証明ではありません。読取・公開にはアプリ側の GCS metadata 検証が引き続き必要です。
世帯削除は旧 Storage オブジェクトではなく、GCS の active/pending 台帳を検査します。

復元は検証済みの新しい空 DB に限ります。元 public データの列をそのまま対応させ、auth は上記 mirror へ明示変換します。
`media_storage_state` は取り込まず、検証完了まで frozen/gcs を保持します。
ランキング project singleton は baseline が作る初期ゼロ行を、**新しい空 DB の import トランザクション内だけで**取り除き、
元のカウンターを復元します。ON CONFLICT DO NOTHING で予算履歴を捨ててはいけません。

FORCE RLS テーブルを non-superuser で戻す場合は `--enable-row-security` と INSERT 形式が必要です。
試験では `pg_dump --data-only --inserts --column-inserts --enable-row-security` →
`pg_restore --enable-row-security` を用い、trigger 無効化や `session_replication_role` の変更はしません。
これは架空 GCP データの round trip 試験です。元 Supabase Auth archive の実変換、IdP import / password login / Google link、
GCS 全 generation の照合、全書込凍結、失効・回復、実 Cloud SQL role / 接続 / 性能 / 復元は別の必須 gate です。
DB の復元で IdP や GCS 本体が同時に戻るわけではありません。切戻しも DB・IdP・台帳の進行位置を合わせて判断します。

## ローカル検証と再生成

```sh
python3 tests/gcp/run-db-tests.py
```

固定 test image を build 後、ランダム名・network none・tmpfs の PostgreSQL 17 container を一つ作り、終了時に削除します。
既存 Supabase、`.env`、外部 DB、実バックアップは読みません。`--skip-build` は作成済み同 image の再試験用です。
既存 migration 全件を source 用 DB に再実行し、表・列・制約・70 の元 RLS・関数・trigger を移行先 catalog と比較します。
source 用の最小 `auth/storage` scaffolding は `tests/gcp/source-shim.sql` にあり、GCP DB には適用しません。
既存 pgTAP 6 suites は fixture の identity shape と管理 role だけ変えて実行し、assertion はそのまま保ちます。
GCS 79 checks、identity/role/ランキング、実 authenticator LOGIN の拒否例、別 DB への架空 dump/restore も実行します。

`020_public.sql` は全 37 migration を反映した source schema-only dump から生成しています。
`source-migrations.json` のファイル集合・SHA256 が変わると検証を止めます。
元 migration 更新時は隔離 source DB を再構築し、`pg_dump --schema=public --schema-only --no-owner` のみを取り、
`python3 db/gcp/generate-baseline.py <schema-only-dump>` で再生成して差分と全検証をレビューします。
生成器へ実データ入り dump を渡しません。許可した差分以外の catalog 変化は runner が拒否します。

## 固定 Cloud Run Job

`Dockerfile.gcp-operator` / `scripts/gcp/database-operator.mjs` は、次の対象にだけ接続する operator image です。
既定の `--plan` はネットワークを使いません。実行には `--execute` と固定 Job の実行 context が必要です。
任意 SQL、DB 名、接続先、テーブル名、GCS URL を入力する機能はありません。

| 対象 | 固定値 |
| --- | --- |
| Project / number | `mfmf-499612` / `92772745697` |
| Job / service account | `mfmf-db-operator` / `mfmf-db-operator@mfmf-499612.iam.gserviceaccount.com` |
| Cloud SQL connection | `mfmf-499612:asia-northeast1:mfmf-db`、private IP + Auth Proxy |
| DB | `mfmf` |
| 暗号化 import | `mfmf-499612-db-migration` bucket の `imports/<plaintext SHA256>.json.age`、数値 generation 必須 |
| 復元試験 DB / role | `mfmf_restore_probe` / `mfmf_restore_proof`。既存なら中止 |

同一 container の Auth Proxy は接続を最大 2 本に制限します。restore-test でも admin 接続を維持したまま、
setup / migrator / proof 接続を順次閉じて切り替え、3 本目を開きません。runtime PostgREST の pool 2 とは独立です。
Job は task 1・parallelism 1・retry 0 とし、script 自体も task index/count/attempt を検査します。
プロセスの上限は 12 分。SQL の自動 retry はありません。接続開始時の proxy 待ちだけを再試行します。

| `MFMF_DB_OPERATION` | 動作 |
| --- | --- |
| `bootstrap` | 固定 DB がなければ作成。既存なら postgres 所有の空 DB だけを受け入れ、固定 roles / baseline / private ledger を一度だけ作成 |
| `inspect` | baseline hash、runtime role、行数、media state / binding 整合だけを検査 |
| `restore-test` | 別の一時 DB で baseline + RLS 負例を実行し、bundle を復元して全行・全列を typed comparison。その DB / 一時 role を撤去 |
| `migrate` | frozen/gcs の未 import・空 DB に、固定列の parameterized INSERT を一つの transaction で実行 |
| `upgrade` | image 内の `db/gcp/migrations/` と適用履歴を比較。未適用 SQL がある場合だけ TTL 検証済み backup を先行し、SQL と checksum を atomic 適用 |
| `activate` | baseline / import SHA / 全 media 参照 / 21 表 guard を検査後、全体書込を有効にし media state を gcs に同 transaction で切替 |
| `freeze` | 同じ固定対象と import SHA を確認し、全体書込と media write を同 transaction で frozen にする。read backend は gcs のまま |

`activate` / `freeze` は全 public 表と auth.users の SHARE ROW EXCLUSIVE lock で進行中の DML を待ち、
media state と private `migration_admin.write_state` を同 transaction で変更します。どちらかが失敗すれば両方 rollback します。
全 21 表の ALWAYS statement trigger は session_user が postgres / mfmf_migrator / mfmf_operator の場合だけ例外とし、
runtime の SECURITY DEFINER 関数も例外にしません。state の FOR SHARE により、旧 repeatable-read snapshot の false 値で
凍結をすり抜ける書込も serialization error で止めます。state 欠損は拒否、guard 欠落や両 state 不整合も operator が拒否します。
IdP 自体や GCS 本体の操作はこの DB guard の対象外なので、切戻しではアプリ入口・IdP の別 gate も同時に満たします。
`activate` は IdP や GCS に問い合わせず、実 IdP UUID / password / Google link と GCS generation の照合は
実行者が完了させる外部 gate です。成功出力も `externalIdentityAndObjectChecks: operator-required` と明示します。

`bootstrap` は public 以外の独自 schema、public の表・sequence・view・関数・型、plpgsql 以外の extension、
event trigger、固定 app role の既存を拒否します。既存 object / role / data の削除や再利用はしません。
途中停止した初期化先が残る場合は、状態を調査してから明示的に復旧し、汎用 reset で自動的に進めません。

### Job の環境と秘密

全操作に `MFMF_DB_OPERATION` と `MFMF_DB_OPERATOR_CREDENTIALS` が必要です。後者は Secret Manager の
`mfmf-db-operator-credentials` から渡す `{postgres,migrator,operator}` だけの JSON です。
各 password は 32〜128 文字の base64url 形式とし、コードや引数には入れません。

- bootstrap のみ `MFMF_DATABASE_PASSWORD`（別 secret `mfmf-database-password`）。runtime の authenticator に設定する値です。
- migrate / restore-test は `MFMF_DB_BUNDLE_SHA256`、`MFMF_DB_BUNDLE_GENERATION`、`MFMF_DB_IMPORT_IDENTITY`。
  最後の値は operator 専用 `mfmf-db-import-identity` から渡します。既存の長期 backup identity を共有しません。
- activate / freeze は期待する `MFMF_DB_BUNDLE_SHA256` のみ。generation や復号鍵は不要です。
- upgrade は `MFMF_DB_DEPLOY_SHA`（main commit の 40 桁 SHA）のみを追加します。

age identity は最大 512 bytes の ASCII、標準 comment / 空行と秘密鍵 1 行だけを許可し、鍵 1 行に正規化して
age の stdin へ渡します。子プロセスの環境へ DB / age / access token を渡しません。
一時ファイルは暗号文だけ（directory 0700 / file 0600）で、平文 bundle はメモリ内に留めます。
GCS は固定 generation と object metadata を照合し、復号後 SHA256 も一致させます。
最大 plaintext / ciphertext はそれぞれ 64 MiB。レスポンス、SQL エラー、行内容、秘密値はログに出しません。
`inspect` 等の成功は固定状態・件数だけ、失敗は固定 stage だけです。

### Import bundle

format は `mfmf-gcp-import-v1`、`source.projectRef` は固定 `aqvmuhqkaqedtxuqwhoq`。
トップレベルは `format` / `source` / `authMirror` / `tables` / `expected` のみです。

`authMirror` は各行に `id`, `provider_subject`, `email`, `email_verified`, `created_at`, `updated_at` の 6 列が必要です。
この Supabase 移行用 format では `provider_subject = id = 元 UUID` を強制します。
未確認メールは NULL、確認済みメールは trim 済み小文字。日時は明示 timezone 付き RFC3339 を元値から保持し、
NULL や欠落を実行時刻で埋めません。パスワード hash / Google identity / IdP 設定はこの bundle に入りません。
それらは別の IdP import / backup の対象です。

`tables` は script の `COLUMNS` にある 19 表だけです。各行は全列を持ち、NULL も省略しません。
`media_storage_state` は含めず frozen/gcs を保持します。`expected.counts` は `auth_users` と同じ 19 表の件数です。
ユーザー 10,000 件、全行合計 50,000 件まで。reserved media asset が残る source は移行を拒否します。
import 順序は auth → media ledger → parent / refs。制約や trigger を止めず、全件成功時だけ import SHA を保存します。

### SQL 更新と復元の検証

baseline（private ledger / freeze guard SQL を含む）と source migration 集合の hash が異なれば、通常配信も停止します。Supabase に新 migration を加えて
GCP 側が追いついていない場合に、Cloud SQL の更新を黙って省略しません。
追加 GCP migration は image 内の `db/gcp/migrations/<14桁timestamp>_<slug>.sql` だけを読みます。
過去の checksum / 適用順序が違う場合は拒否します。private ledger と advisory transaction lock を用い、
未適用が 0 件なら backup 作成も DDL もありません。

未適用があれば固定 Cloud SQL の backup API で TTL 14 日を要求し、SUCCESSFUL / expiry / 作成時刻を実確認します。
同じ main SHA の backup 再利用は 15 分以内だけです。TTL 未対応・古い backup・重複・不明な作成結果では SQL を始めません。
backup は DB のみです。IdP と GCS 本体の巻戻しや、破壊的 migration 後の旧アプリ互換性を保証しません。

```sh
node --test tests/scripts/database-operator.test.mjs tests/scripts/database-prebackup.test.mjs
python3 tests/gcp/run-operator-tests.py
```

後者は既存 DB / 本番 env に触れず、専用 image と network-none の一時 PostgreSQL を用います。
7 操作と再 import 拒否、全列復元、最大 2 接続、試験 DB / role の撤去を検査します。
実 authenticator 接続で frozen 時の read / 同値 identity sync 許可と DML / identity変更 / SECURITY DEFINER 書込拒否、
activate 後の書込許可、state 変更の故障注入時の atomic rollback、旧 repeatable-read snapshot の拒否も検査します。
`--skip-build` は同じ source で作成した test image の再試験専用です。
実 Cloud SQL の backup / PITR、private 接続、低メモリ性能、IdP 認証・失効はこの隔離試験では証明できず、切替前の別 gate です。
プロセスが強制停止されて一時 DB / role が残った場合は、次回実行を拒否します。名前が一致するだけで無条件削除しません。
