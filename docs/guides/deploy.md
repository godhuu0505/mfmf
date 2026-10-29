# デプロイ・リリース手順

本番は **GitHub ActionsからCloud Runへ配信**します。認証はIdentity Platform、DBはCloud SQL、画像はGCSです。
**DB・認証の切替と本人の書込を確認済み。** GCP候補100%でGoogleログイン、既存のprofile/世帯owner/pet/home一致、軽量2並行GET、frozen/gcsでの全行全列再照合を確認しました。切替記録の[PR193](https://github.com/godhuu0505/mfmf/pull/193)は[全7 CI](https://github.com/godhuu0505/mfmf/actions/runs/40742163316)成功後にmainへmerge済みです。
2026-10-28 18:03:33.456726 UTCにactivationが成功し、DB書込enabled・media gcsへ切り替わりました。18:04:29 UTCに本人プロフィールの同値保存と成功表示も確認済みです。事後inspectでDB enabled・media writes gcs・read backend gcs・imported=trueと全件数維持を確認しました。
固定Jobの通常3項目envへの復帰とupgradeのapplied=0・sourceManifestVerified=trueを確認済みです。workflowを再開し、GETでstate=active、GCP_AUTH_ENABLED/GCP_DEPLOY_ENABLEDともtrueを確認しました。
main `2a37a40` の通常配信は [Deploy Production run40743471560](https://github.com/godhuu0505/mfmf/actions/runs/40743471560)の実行結果を参照してください。[移行記録](../explanation/gcp-migration.md#現在の実装と切替記録)と配信結果を分け、workflow再開やCI成功だけで配信成功と扱いません。
旧Supabase/Vercel経路はローカル開発・履歴・個別の復旧判断のために残し、通常配信では使用しません。
VercelのGit自動配信は引き続き無効です（D22）。

## 本番フロー

| トリガ | 配信先 | DB更新 | ワークフロー |
| --- | --- | --- | --- |
| PR | CIのみ | 架空データの隔離試験 | `.github/workflows/ci.yml` |
| mainへpush、GCPモード有効 | Cloud Run | 同SHAの固定operator Job `upgrade` | `.github/workflows/deploy-production.yml` |

1. PRで通常CIに加え、GCP baseline/RLS/復元・実PostgREST・operator・両モードbuildを通す。
2. `GCP_AUTH_ENABLED=true` / `GCP_DEPLOY_ENABLED=true`、workflow有効、templateとserving revisionが同じGCPモードであることを確認する。
3. mainへの新しいpushで、verify → WIF認証 → 同SHAのapp/operator image build → DB `upgrade` → tag付き0% stage → smoke →100% promoteを実行する。
4. Supabase `migrate` とVercel `deploy` はskipする。既存DB・認証モードの初回切替、freeze解除、Job作成、IAM変更は行わない。

設定・固定secret参照・Job検証の正は [GCP DB通常配信](./gcp-database-deployment.md)。
固定Jobは事前に `upgrade`、レビュー済みmain SHA、operator資格情報だけの通常形へ戻し、前の実行完了を確認する。
手動import/restore用の環境を通常配信が自動で取り除くことはない。
workflowを有効化するだけでは配信されない。受入後の新しいmain実行を確認し、旧false-mode runはrerunしない。
初回false→true切替を通常配信のmode検査緩和で代用しない。

## DB変更と失敗時の境界

本番SQLと復元契約は [db/gcp/README.md](../../db/gcp/README.md)。元の `supabase/migrations/` は互換元・ローカル開発に残し、
source manifestでGCP baselineとの対応を検証する。元migrationを増やすだけでは本番へ反映されない。
追加GCP SQLは `db/gcp/migrations/` のchecksum ledgerとadvisory lockで適用し、未対応の元migrationや履歴差異は停止する。

**現時点では、未適用SQLがある通常配信はprebackupの期限検査で停止する。**
Standard on-demand backupの実 `expiryTime` がNULLのためで、14日を要求しただけでは期限付きと扱わない。
SQLが0件ならbackup作成・DDLなしで配信できる。SQL更新を開放するには、保持・削除方針と実検証を別途完了させる。

appのtraffic rollbackはDB、IdP、secret versionを戻さない。SQLは旧revisionとの互換を保つ。
source Supabaseの凍結解除・逆同期やDB復元は、最新書込を失わないことを確認する別の運用判断であり、自動実行しない。

## バックアップと復旧範囲

- Cloud SQLは日次18:00 UTC（翌03:00 JST）・14件保持、PITRログ7日、削除保護と最終backup30日を設定する。設定の存在と実復元成功は別に記録する。
- 初回の同instance managed backup復元は18分47.589秒で成功。復元後の全行全列比較・frozen/gcsのinspect、backup設定一致・修復不要、新しいpost-restore backupまで確認済み。証跡は [移行記録](../explanation/gcp-migration.md#現在の実装と切替記録)に残す。PITRは常に別instanceを作るため、この試験で実PITRまで証明したとは扱わない。
- Standard on-demand backupは明示削除まで無期限。日次14件保持と手動backupは別枠。全件容量を観測し、復旧点を費用だけで自動削除しない。
- Identity Platformのアカウント・provider link・password hash設定はSQL backupに含まれない。手動暗号化exportと独立した復号・restore plan検証が成功し、4ユーザー・Google link4件・BCRYPT1件を保全した。今回はパスワード再設定必須0件で、原本とのhash同値も確認済み。実アカウントの全件restoreと定期自動backupは未実施。将来APIでhashを取得できない場合は再設定が必要で、旧hashを無条件補完しない。復旧点は最後に成功・復号検証した手動export時点であり、SQLの日次backup/PITRと同じRPOではない。復元時は全セッション失効を別gateにする。
- GCS本体はSQL backupと別に保護する。[画像移送・隔離復元](./storage-migration-operator.md)の世代・binding・hash検証、soft delete、terminal cleanupを使う。DB復元だけで画像やIdPも巻き戻ったとは扱わない。
- 元Supabaseのpublic＋credential Authは凍結し、暗号化した最終原本とともに保全する。Authの全session状態を凍結したものではない。解除は [専用手順](./database-auth-backup.md)で明示的に行い、通常配信から触れない。

## 旧Supabase/Vercelモードの手順（参照専用）

以下は `GCP_AUTH_ENABLED=false` の旧構成だけに適用する。**凍結した移行元へ実行しない。**
本番GCPの復旧に `supabase db push`、旧Deploy Productionのrerun、Vercel rollbackだけを使わない。

### 旧構成の初回セットアップ

### 1. Vercel プロジェクト ID を取得

```bash
npx vercel link            # 対象の Vercel プロジェクトを選択
cat .vercel/project.json   # orgId / projectId を確認
```

`.vercel/` は `.gitignore` 済み（コミットしない）。

### 2. Vercel トークンを発行

Vercel ダッシュボード > **Account Settings > Tokens** で発行する。

### 3. GitHub Secrets を登録

リポジトリの **Settings > Secrets and variables > Actions** に以下を登録する。
本番を保護したい場合は **Settings > Environments** で `production` を作り、
Secrets をその Environment スコープに置く（`production` に承認ルールを付けると誤発射を防げる）。

| Secret | 用途 | 取得元 |
| --- | --- | --- |
| `VERCEL_TOKEN` | Vercel デプロイ | Vercel Account Settings > Tokens |
| `VERCEL_ORG_ID` | Vercel デプロイ | `.vercel/project.json` の `orgId` |
| `VERCEL_PROJECT_ID` | Vercel デプロイ | `.vercel/project.json` の `projectId` |
| `SUPABASE_ACCESS_TOKEN` | Supabase migrate | Supabase Dashboard > Account > [Access Tokens](https://supabase.com/dashboard/account/tokens) で発行 |
| `SUPABASE_DB_PASSWORD` | Supabase migrate | Supabase Dashboard > 対象プロジェクト > Project Settings > Database |
| `SUPABASE_PROJECT_ID` | Supabase migrate | Project URL の subdomain（例: `abcdefghijklmnopqrst.supabase.co` の左側 20 文字） |

Supabase 系 3 つを **`production` Environment** に登録する。
未設定の場合は `migrate` と Vercel deploy が停止します。古い DB に新しいコードだけを出すことは許可しません。

### 4. バックアップの公開鍵を登録

公開リポジトリの Actions Artifact はリポジトリ閲覧者も取得できます。**平文の本番 DB を保存しないでください。**
管理者の端末に `age` を導入し、リポジトリ外の保護された場所で鍵を作ります。

```bash
umask 077
mkdir -p "$HOME/.local/share/mfmf-backups"
age-keygen -o "$HOME/.local/share/mfmf-backups/identity.txt"
age-keygen -y "$HOME/.local/share/mfmf-backups/identity.txt" > "$HOME/.local/share/mfmf-backups/recipient.txt"
gh variable set SUPABASE_BACKUP_AGE_RECIPIENT --repo godhuu0505/mfmf < "$HOME/.local/share/mfmf-backups/recipient.txt"
```

GitHub に登録するのは **公開鍵だけ**です。`identity.txt` は復号に必須の秘密鍵なので、
コミット・Artifact・ログ・GitHub Secrets へ入れず、別の安全な保管先にも控えを置いてください。
鍵を紛失すると過去のバックアップは復元できません。鍵を替えた後も、旧バックアップの保持期間中は旧鍵が必要です。
公開鍵未設定・不正値・dump失敗・暗号化失敗は、migration より前に処理を停止します。

### 5. Vercel 側の環境変数

`NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` を Vercel の
**Settings > Environment Variables** の **Production** に設定する。
`vercel pull --environment=production` がこれらを取得してビルドに使う
（GitHub Actions の CI ビルドはプレースホルダ値で通すだけで、実値は Vercel から取得する）。
変数の一覧は [reference/configuration.md](../reference/configuration.md) を参照。

## Supabase（DB）マイグレーション（旧モード限定）

`supabase/migrations/` の SQL は **GitHub Actions の `migrate` ジョブで自動適用**される
（`supabase/setup-cli` → `supabase link` → `supabase db push` の 3 ステップ）。

- **main マージ時**：`deploy-production.yml` の `migrate` が走り、未適用分を本番 Supabase に push してから Vercel Production deploy が続く。
- main マージ時点でスキーマが本番 DB に進む点に注意（破壊的変更は下記参照）。

### 新しい migration を足すときの手順

1. ローカルで `supabase migration new <name>` → 生成された SQL を編集。
2. ローカル Supabase で動作確認：`supabase db reset`（既存データは消える）。
3. PR を出して CI（lint / typecheck / build）を緑にする。
4. main マージ → `deploy-production.yml` が `migrate` → `deploy` の順で動き、本番反映される。

### 破壊的変更（DROP / カラム削除 / 型変更）の運用

main マージ = 本番反映のため、destructive 変更は **main マージ時点で本番 DB に作用する**。
事故を避けるため、以下を守る：

- PR レビュー時に migration ファイルを必ず目視確認する。
- ローカルで `supabase db reset` → アプリの主要画面を一通り操作してから main にマージする。
- 「main マージ → 本番 DB が古いコードに見られて RLS / 型不一致で落ちる」期間が短くなるよう、PR は小さく刻む。
- destructive な SQL（`DROP TABLE` / `DROP COLUMN` / `ALTER COLUMN ... TYPE` / `TRUNCATE` / `DELETE FROM`）を含む PR は `check-destructive-migration` ジョブが GitHub の Warning アノテーションを出す。Warning が出た PR は **マージ前に Artifact からの復旧可否を確認**する。

### 失敗・誤適用からの復旧

**Free プランには自動バックアップも PITR も無い。** ロールバック手段は以下のいずれか：

#### 1. 暗号化済み GitHub Actions Artifact からの復元

`migrate` ジョブは `supabase db push` の**前に**本番 DB の schema と data を取り、
`scripts/backup-db.sh` で age 暗号化した `.sql.age` だけを Artifact として90日間保持します。
名前は `supabase-backup-production-encrypted-<commit-sha>`（main マージの commit SHA）。
平文は権限を絞った一時ディレクトリにのみ作り、正常時・異常時とも削除します。
これはマージ直前の退避であり、定期バックアップや写真のバックアップではありません。

> ⚠️ **dump 対象は `public` スキーマのみ**。`auth.users`（Supabase Auth 管理）/ `storage.*`（Storage メタデータ）/ Storage バケット本体（`record_photos` の画像ファイル）は含まれない。
> - Authを含む原本保全は [public＋Auth暗号化バックアップ](./database-auth-backup.md) を使う。旧publicのみのArtifactでAuthまで復元できるとは扱わない。
> - `record_photos` の画像本体は Storage バケットにあり、DB 復元しても画像は戻らない。Storage 自体の事故からの復旧手段は Free プランでは無い（rclone 等での日常的な同期が唯一の自衛策）。

復元手順（ローカルから）：

```bash
# 1. GitHub の該当 Actions run（Actions タブ → 対象 workflow → 該当 run）から
#    Artifact "supabase-backup-production-encrypted-<sha>" をダウンロードして展開する。
#    リポジトリ外の保護されたディレクトリで復号する。SQL を画面へ出力しない。
umask 077
age --decrypt --identity "$HOME/.local/share/mfmf-backups/identity.txt" \
  --output pre-migrate-schema.sql pre-migrate-schema.sql.age
age --decrypt --identity "$HOME/.local/share/mfmf-backups/identity.txt" \
  --output pre-migrate-data.sql pre-migrate-data.sql.age

# 2. Supabase Dashboard → Project Settings → Database → Connection string
#    から direct connection の URL（postgres://postgres:<PW>@db.<ref>.supabase.co:5432/postgres）を取得。

# 3. （スキーマも巻き戻す場合）まず該当の migration を取り消す or DB を一度クリアする。
#    安全な順は：
#    - 影響テーブルの行を `DELETE FROM` して空に
#    - 破壊された migration の逆方向 SQL を手で書いて適用、または `supabase migration repair --status reverted <version>` で履歴のみ修復
#    - dump からテーブル定義を `psql "$DATABASE_URL" -f pre-migrate-schema.sql` で再構築（既存テーブルは CREATE で失敗するので必要な部分だけ抜粋）

# 4. データだけ戻すなら：
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f pre-migrate-data.sql
```

> ⚠️ 復元中はアプリが整合しない状態になる。Vercel Dashboard で過去デプロイに一時的にロールバックしておくか、メンテモードを掲示する。

旧形式の平文 Artifact が残っている場合は、内容を出力せず暗号化して保護された場所へ退避し、
復号後のハッシュ一致を確認してから公開 Artifact を削除します。保持期限まで放置しないでください。

#### 2. Supabase が保持しているバックアップからの復元

有料プランの日次バックアップや PITR を利用している場合は、Dashboard で復元可能な時点を確認します。
**事故後のアップグレードで、Free 利用中の過去データが復元できるとは保証されません。**
事前に確保したバックアップを基準にしてください。対象・保持期間は
[Supabase 公式のバックアップ手順](https://supabase.com/docs/guides/platform/backups)を参照します。

`supabase_migrations.schema_migrations` の履歴を直接いじる場合は `supabase migration repair --status applied|reverted <version>` を使う。

#### 3. Storage（写真）の破損

**DB backupに画像本体は含まれない。** 旧Supabaseの写真・アバターは [画像原本バックアップ](./storage-operator-backup.md)、
現行GCSは [画像移送・隔離復元](./storage-migration-operator.md)を参照する。画像本体とDB参照を別々に巻き戻して整合を失わない。

### `supabase db push` 自体が失敗した時

- 単一 migration ファイル内なら CLI が暗黙にトランザクションで包むため、エラー時は**そのファイル全体がロールバック**される（`schema_migrations` にも残らない）。
- 複数 migration があり N 個目で失敗した場合、N-1 個目までは適用済み。SQL を直して **同じ commit を re-run** すれば N 個目から再開される（冪等）。
- 明示的に `COMMIT;` を書いた DDL を含めると部分適用が残り `supabase migration repair --status applied <version>` で履歴修復が必要になる。原則 migration ファイル内で明示 COMMIT を書かないこと。

### `supabase link` が `project is paused` で失敗した時

Free プランは低利用が続くと一時停止されます。この場合は migration 前に止まり、
Vercel Production も実行されません。既存プロジェクトの復帰には
**Actions → Resume Supabase Production → Run workflow（main）** を使います。
`workflow_dispatch` 専用で、production Environment の既存
`SUPABASE_ACCESS_TOKEN` / `SUPABASE_PROJECT_ID` を使います。DB password は不要です。
復帰後の健康確認だけを再実行するときは **`verify_only` を有効**にします。
このモードは GET だけを使い、対象が `INACTIVE` なら復帰せず失敗停止します。
実際に停止中のプロジェクトを復帰するときは既定の `verify_only=false` を使います。

1. Management API で対象プロジェクトの状態を確認する。
2. 停止状態 `INACTIVE` のときだけ `POST /v1/projects/{ref}/restore` を一度送る。
   既に `ACTIVE_HEALTHY` / `RESTORING` / `COMING_UP` なら POST せず健康確認へ進む。
   それ以外の初期状態は停止し、Dashboard で原因を確認する。
3. 最大20分、プロジェクトと `db` / `auth` / `rest` / `storage` がすべて
   `ACTIVE_HEALTHY` になるまで待つ。API エラー・失敗状態・タイムアウトはジョブを失敗させる。
4. 成功後に、反映したい commit の **Deploy Production** run を確認して手動で再実行する。
   バックアップ → migration → deploy の既存ゲートを通す。

復帰 workflow は SQL・migration・Vercel deploy を実行せず、API 応答本文・token・接続情報も
ログへ出しません。通常の本番デプロイと同じ concurrency group で直列化します。
復帰要求の通信結果が不明でも自動再送しません。Dashboard の状態を確認してから再実行してください。

[公式の停止・復帰仕様](https://supabase.com/docs/guides/platform/free-project-pausing)では
停止後1年以内が復帰可能期間です（2026-10-27確認）。プロジェクト個別の復帰可否や token の権限は
API が判定します。権限不足・期間超過等で拒否された場合は Dashboard / Supabase サポートで確認し、
別プロジェクトへの復元やアップグレードをこの workflow で自動実行することはありません。
API 仕様: [状態取得](https://supabase.com/docs/reference/api/v1-get-project) /
[復帰](https://supabase.com/docs/reference/api/v1-restore-a-project) /
[サービス健康確認](https://supabase.com/docs/reference/api/v1-get-services-health)。

## 補足: リリースノート / バージョニング

本番デプロイは main マージで自動化されているため、GitHub Release はデプロイのトリガではなく
**変更履歴の記録用途**になる。タグ付け + リリースノートを残したくなったら、Conventional Commits を
ベースに **release-please** や **Changesets** を導入し「バージョン上げ PR → マージで自動タグ + Release
公開（ノート生成のみ、デプロイには非連動）」にできる。まずは無しで運用し、必要になったら検討する。


### 復帰後の健康確認が HTTP 400 になる場合

プロジェクトが既に `ACTIVE_HEALTHY` なら、原因調査のために復帰 workflow を繰り返さない。
**Actions → Diagnose Supabase Health → Run workflow（main）** は GET だけを実行する。
プロジェクト状態を確認した後、以下の固定した形式を計7回比較する（合計最大8 GET、再試行なし）。

- HTTP 400 が発生した repeated `services` と `timeout_ms=5000`
- repeated `services` で `timeout_ms` を省略
- CSV `services` で `timeout_ms` を省略
- `db` / `auth` / `rest` / `storage` を1つずつ指定して `timeout_ms` を省略

[公開 OpenAPI](https://api.supabase.com/api/v1) は CSV と配列の両方を許可し、
`timeout_ms` は任意の 0〜10000 の整数とする。
[Supabase 自身の E2E](https://github.com/supabase/supabase/blob/master/e2e/studio/scripts/common/wait-healthy-services.ts)
では CSV と既定タイムアウトを使っている。

2026-10-27 の [GET-only 診断 run](https://github.com/godhuu0505/mfmf/actions/runs/40356139502)
では `timeout_ms=5000` を付けた形式だけが HTTP 400 となり、許可語彙で抽出した validation は
`timeout_ms` の `invalid_type` だった。同じ repeated `services` から `timeout_ms` を省くと
HTTP 200 で4サービスすべて正常になり、CSV・各単独形式も正常だった。
この結果に基づき復帰 workflow の健康確認では任意の `timeout_ms` を省略する。
API 内部の型変換の問題かどうかは断定せず、クライアントの30秒通信上限と20分の全体上限は維持する。

出力するのは固定された probe 名、HTTP 状態、許可済みの validation 分類と項目名
（`services` / `timeout_ms` / `ref`）、4サービスの状態だけ。API 本文・自由文エラー・
project ref・token・接続情報は出さず、応答の読み取りも32 KiBで打ち切る。
`allServicesHealthy` と `allQueriesAccepted` は別に出力する。4サービスの健康を1つの全体GET、
または4つの単独GETで確認できなければ診断は失敗する。
この workflow は restore・設定変更・migration・deploy を行わない。
