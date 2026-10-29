# GCP の日次バックアップと保持

この手順は移行後の Identity Platform と Cloud SQL を対象とします。元Supabaseの凍結と暗号化原本は
[別手順](./database-auth-backup.md)で保全し、この運用から解除・更新・削除しません。
以下は実装した契約です。実Jobの成功、暗号文の独立復号、復元、削除API、Scheduler有効化の受入はそれぞれ別に確認します。
設定やfixture成功だけで実環境の復旧を保証しません。

### 2026-10-29 の復元受入

- 新しいCloud SQL backupを本番とは別のprivate instanceへ実復元（16分26秒）。読取専用transactionで
  24表・273行の全列、RLS policy74件・関数43件・runtime roleを本番と照合し、一致しました。
  復元先に継承された削除保護は、照合後の一時instance撤去時にだけ解除します。本番の削除保護は維持します。
- 隔離Identity Platform tenantで架空3ユーザーのBCRYPT2件・native SCRYPT1件を暗号化・独立復号・空の別tenantへ復元。
  UID、確認済み/無効化状態、claims、hashを照合し、実password login、無効ユーザー拒否、既発行token失効を検証しました。
  試験tenantは全削除し、一時的なtenant許可設定も元に戻しました。本番ユーザーへの書込・メール送信は0件です。
- 本番4ユーザー・Google対応4件・BCRYPT1件を新exporterで読取保全し、独立保管鍵による復号・restore planを照合しました。
  これは実ユーザーへの再importやGoogle providerの実復元試験ではありません。

実行コードと機微な復旧材料を含む原本はprivate operator保管です。
Job/Schedulerの最終配信・削除APIの受入結果は [PR #195](https://github.com/godhuu0505/mfmf/pull/195) に追記します。

## 日次構成と権限

| Job / 同名の専用SA | JST | 処理 | 書込先・境界 |
| --- | --- | --- | --- |
| `mfmf-identity-backup` | 毎日04:17 | 全ユーザーとpassword hash設定を2回読取・照合し、age暗号化 | 非公開 `mfmf-499612-identity-backups` の `identity/` に新規暗号文と集計receiptだけを作成。IdP更新権限なし |
| `mfmf-db-retention` | 毎日04:47 | 固定Cloud SQLの所有marker付き旧backupを条件付き回収 | SQLデータ・設定・restoreには触れない。非公開 `mfmf-499612-backup-ops` の `retention/latest.json` だけをgeneration CASで更新 |

Cloud Schedulerは専用 `mfmf-backup-scheduler` SAのOAuth tokenで固定2 Jobの`:run`だけを呼びます。
各Jobはtask/parallelism1、retry0、timeout900秒、1CPU/512MiB、GEN2、VPC・secret mountなしです。
Cloud Run metadataのproject ID/number・専用SAを検証してtokenをメモリに取得し、サービスアカウント鍵ファイルは作りません。
公開リポジトリの活動停止によるGitHub scheduled workflow無効化に依存しないため、Cloud Schedulerを使います。

初期構築は `bootstrap-backups.mjs` の既定planから、`prepare` → `bind-jobs` → `schedule` の順です。
既存資源の差異を自動修復せず停止します。IAMはETag付きで既存他principalを維持し、専用SAの予期しない追加権限を拒否します。
`schedule` は同一image/SHAの両Jobが実成功したExecutionと標準Scheduler service agentの存在を確認してから有効化します。
通常配信は同じmain SHAのoperator imageで**既存**2 Jobを更新・実行し、成功後にDB `upgrade`、app stage/probe/promoteへ進みます。
通常配信からJob作成・IAM変更・Scheduler変更は行いません。

## Identity Platform の保全

`identity-backup.mjs` は固定projectの `accounts:batchGet` と `signIn.hashConfig` だけをGETします。
ユーザー最大1,000件・10page・平文16MiB、同じ2scanと前後hash設定が一致することを要求します。
これはAPI読取間の同一性検査で、DBと原子的に同じ時点を取るsnapshotではありません。
未知のcredential・provider・MFA/tenant等を黙って捨てず停止します。セッションtoken、OAuth秘密鍵、メール送信設定等は含みません。

UID・Google provider対応・SCRYPT設定とhash、明示形式を検証できたBCRYPTを保全します。
本projectは既知のBCRYPT移行とIdentity Platformが生成したSCRYPTだけを使う前提です。RESTのaccount応答は
個別のhash方式を返さないため、非BCRYPTでsalt付きのhashをbytesだけから未知方式と識別できません。
将来別方式の外部hashをimportする場合は、対応するbackup/restore gateの明示追加と実検証、またはpassword再設定を先に計画します。
APIがpassword hashを返せないユーザーは再設定必須として数え、古い原本のhashで補完しません。
権限不足のREDACTEDは停止します。移行時に確認したBCRYPTが将来のAPIでも常に取得できると保証しません。
[REST UserInfo](https://docs.cloud.google.com/identity-platform/docs/reference/rest/v1/UserInfo)と
[CLI exportのhash制約](https://firebase.google.com/docs/cli/auth#auth-export)は区別します。

平文はメモリからage stdinへ渡し、暗号文だけをGCSへ `ifGenerationMatch=0` で作ります。
書込後の同一generationを全量再取得してSHA256を照合し、集計receiptも別objectとして排他的に保存・再読します。
暗号文・receiptの保存と独立復号は別の証明です。公開recipientだけをimageに含め、**復号用秘密鍵はJob・GCP secretへ置かず独立保管**します。
SQL import用の一時復号鍵を、この長期保全鍵の代用にしません。

bucketはTokyo STANDARD、UBLA・PAP enforced、versioningなし、30日保持policyと`identity/`の30日削除lifecycle、soft delete7日です。
Jobにはobject create/getだけを付与し、上書き・削除・listを許可しません。保持policyはロックしないため、
project管理者による設定変更まで防ぐWORM保管とは説明しません。lifecycleは非同期で、30日ちょうどの削除や保管費上限を保証しません。

復旧点は最後に保存成功し、独立した鍵で復号・restore plan検証できたexport時点です。
日次実行が正常なら約1日の間隔ですが、失敗・停止時は古くなります。SQLの日次/PITR7日と同じRPOではありません。
Job失敗と最新成功時刻を運用担当者が確認します。SchedulerのHTTP成功だけではJob成功を証明しません。

## SQL の保持契約

Standard ON_DEMANDは明示削除まで無期限です。`ttlDays=14` の要求だけでは削除されません。
[公式保持仕様](https://docs.cloud.google.com/sql/docs/postgres/backup-recovery/backup-options#backup_retention_2)を前提に、次の条件をすべて満たしたbackupだけを削除します。

- 固定instance `mfmf-db`、同じinstance作成時刻、Tokyo/PostgreSQL17、現在のprivate IP・backup/PITR等の設定一致。
- `ON_DEMAND` / `SUCCESSFUL`、descriptionが `mfmf-managed-preupgrade-v1:<main SHA40桁>` に完全一致。
- backupの開始・完了とも14日以上前。同instanceの別の成功した復旧点が48時間以内に開始し、旧backupの完了より新しい。
- 全page一覧と全件の固定名個別GETが完了し、全ON_DEMANDが8件以下・最大課金bytes合計1GiB以下。
  一覧は容量を省略するため、個別GETの実値を使う。不明値を0とみなさない。
- instanceがRUNNABLEで、進行中SQL operationがない。削除直前にも対象・新しい復旧点・instance設定・receipt世代が一致する。

AUTOMATED / FINAL、初回移行用の既存手動backup3件、専用probe marker等はこの削除対象外です。
他markerも8件/1GiBの手動枠には含めます。上限超過時は枠を空けるために自動削除せず停止します。
14日は最低保存期間で、日次遅延・停止・復旧点不足ならさらに残ります。

[DeleteBackup API](https://docs.cloud.google.com/sql/docs/postgres/admin-api/rest/v1/Backups/DeleteBackup)はETag条件を持たないため、
固定IDの直前照合と管理操作の排他を境界にします。別operatorのrestore・設定変更・backup削除を同時に行わないでください。
DELETEは1回だけ送信し、自分が送った固定対象の同一operation成功を確認します。削除直後の対象GETは404、
または実APIで観測した403を検査対象としますが、**403だけを不存在の証拠にはしません**。
同じtokenで直後の完全一覧と全件個別GETが成功して対象がなく、事前に固定した新しい復旧点が一覧にも存在し、
個別GETの内容・48時間以内の開始・instance作成時刻と設定が再一致することをすべて要求します。
[AIP-193](https://google.aip.dev/193#permission-denied)の403は存在/不存在を区別しないため、この限定経路以外の403は停止します。
対象GETが200、一覧や復旧点を取得不能、情報が変化した場合も停止し、応答不明時にDELETEを再送しません。
専用SAのSQL権限は `cloudsql.backupRuns.delete/get/list` と `cloudsql.instances.get/list` です。
create・restore・instance更新やDB接続権限は付けません。[公式IAM表](https://docs.cloud.google.com/sql/docs/postgres/iam-permissions)を参照してください。
`mfmfBackupQuotaUser` は `serviceusage.services.use` だけを含み、固定projectで
IdP保全・SQL保持・既存DB operator・通常deployerの4SAだけに付与します。Scheduler SAには付けません。
固定projectを `X-Goog-User-Project` で指定するための権限で、同projectのSAでもこの明示指定の要件は変わりません。
APIの有効化・無効化やquota変更権限は付けません。[公式system parameter契約](https://docs.cloud.google.com/apis/docs/system-parameters)を参照してください。
bootstrapは新roleが無ければ作成し、ETag付きproject IAMで不足bindingだけを追加して既存grantを保持します。
既存roleの権限が異なる場合は停止し、自動修復しません。

receiptは固定pathのgenerationを読み、CASで`running`を先に保存します。成功だけ`success`へ更新し、同generationを再読します。
policy/version・3moduleの実装SHA256・main SHA・instance作成時刻・集計を保持し、個別backup本文やユーザー情報は出しません。
失敗時は`failed`、結果不明時は`running`が残り得ます。`running`の自動引継ぎは行いません。
operatorは実operationと保存済み世代を照合してから回復を判断し、手で`success`へ書き換えてgateを通さないでください。

未適用SQLがある `upgrade` は、30時間以内の成功receiptと現在のinstance設定・実装hashを作成前に確認します。
直前backup成功後も同じreceipt世代を再確認し、完全一覧・容量を再検査してからSQLへ進みます。
これを満たす場合だけStandardのNULL expiryを受け入れます。成功receiptが無い・古い・変更された場合はSQL適用前に停止します。
同SHAのbackup再利用は開始15分以内だけです。詳細は[通常配信](./gcp-database-deployment.md#更新直前バックアップと保持期限)を参照してください。

## 受入・障害時・復元

1. 初期構築後、両固定Jobを1回ずつ実行し、image/SHA・単一成功・再試行0・GCS世代とreceiptを確認する。
2. IdP暗号文を独立した環境へgeneration指定で取得し、保管鍵でメモリ内復号する。
   `verifyEncryptedBackup` でhash・集計とrestore planを検証する。`decodeRestoreArchive`は機微なplanを返すためログへ出さない。
3. 実IdP復元は別の明示操作とする。空の隔離先、UID/provider/hash一致、`allowOverwrite=false`、全対象のsession失効と実ログイン/失効確認を必要とする。
   password再設定必須、回復先initialEmailの相違は個別対応する。復号・plan検証だけを実account復元成功と呼ばない。
4. SQL削除APIは専用の新規probe backupで実検証する。14日未経過のprobe削除は通常cleanupとは別のoperator操作で、通常コードへ例外を追加しない。
   この試験は14日経過の実削除を証明しない。時間境界は架空fixture、後日の実cleanupは独立証跡とする。
5. 実Cloud SQL restoreは停止計画と事前backup、復元後の全行/全列・RLS・設定検証が別途必要。
   同instance restoreと別instance PITR、IdP/GCSの復元は別々の試験であり、稼働DBへの無条件restoreは禁止する。
6. 実受入後だけSchedulerを有効化し、次のmain通常配信も確認する。失敗時は対象Job/operation/receiptを読み、未知のmutationを盲目的に再試行しない。

旧Supabaseの凍結原本や画像は維持します。復旧のためにguard・RLS・失効確認を弱めたり、旧DBへ接続先だけを戻したりしません。
ジョブ失敗の通知先・対応者は運用側で確認します。固定stage/HTTP statusと集計を使い、API本文・hash・メール・復号鍵は出力しません。

## 月額の前提

31日、税10%、換算157.195円/USDを仮定します。既存のJPY SKU試算2,850.67円（復元予備込み）に、
Scheduler2件×$0.10とJob2件×31日×最低60秒×($0.000018/vCPU秒＋0.5GiB×$0.000002/GiB秒)を足すと、
追加約46.80円、**合計約2,897.47円/月**です。追加分は無料枠を使わず計算しています。
[Scheduler料金](https://cloud.google.com/scheduler/pricing)と[Cloud Run Jobs料金](https://cloud.google.com/run/pricing#jobs)が根拠です。
既存appの共有Run無料枠も利用できなければ、同負荷の合計は約3,174.48円になります。

46.80円は上限ではありません。両Jobが毎日900秒動けばScheduler込み追加約217.91円となり、
通常配信時の追加実行、手動probe、GCS暗号文/soft delete/操作、build/AR、restoreの一時費用は別途増えます。
無料枠は請求アカウントで共有され、実通貨のSKU・適用税・実行時間を優先します。
月3,000円のbudget alertは停止装置ではありません。保持世代や復元品質を削って帳尻を合わせず、使用量と予算を再判断します。
