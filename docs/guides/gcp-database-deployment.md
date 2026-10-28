# GCP DB・認証モードの通常配信

この経路は、初回移行・復元検証・固定revisionの切替を終えたサービスの通常配信用です。
Cloud SQL / Identity Platform の初期化や、Supabaseからの初回切替を自動実行しません。

## モードの境界

repository variable `GCP_AUTH_ENABLED` は未設定なら `false`、値は `true` / `false` だけです。
`false` は従来のSupabase migration・Vercel配信・任意のCloud Run配信を維持します。
`true` はSupabase migrationとVercel配信をskipし、`GCP_DEPLOY_ENABLED=true` を必須にします。
Cloud Runのtemplateと実際の100% serving revisionの両方が要求モードと一致しなければ、buildやDB更新前に止めます。

GCPの公開・サーバーフラグは両方trueで一致し、build時のSupabase公開値は無効な固定placeholderです。
設定取得にVercelを使いません。既存3secretとDB password / Identity Platform API keyの2secretは、
コミット済みの固定project/正のversion番号への参照を使います。`latest`や生のserver secretを公開manifestへ入れません。
任意のSentry設定は既存サービスの固定secret参照だけを再利用します。

runtimeは既存の単一container / 1CPU / 1GiB / concurrency2 / min0-max1を検査します。
Direct VPCは `mfmf-db-network` / `mfmf-app-tokyo` / `PRIVATE_RANGES_ONLY` 固定で、connectorやNATを作りません。
通常配信がこれらの資源設定を変更することもありません。

## DB更新ジョブ

同じmain SHAからapp imageと `Dockerfile.gcp-operator` imageをbuildし、両方のdigestを確定します。
既存の `mfmf-db-operator` Jobだけを取得・検査し、ETag付きでimageとdeploy SHAを更新して実行します。
Jobの作成、IAM変更、任意command/SQL/override、import、restore、初期baseline適用は通常配信に含めません。

Jobは専用SA、single task/parallel1、retry0、timeout1800秒、1CPU/1GiB、GEN2、固定Direct VPC、
`args=["--execute"]`、`MFMF_DB_OPERATION=upgrade` に固定します。
資格情報は `mfmf-db-operator-credentials` version1への参照だけです。
実行結果のJob名・image digest・main SHA・単一成功・再試行なしを確認した後だけ、新appをtag付き0%でstageします。
その後は既存の匿名smokeとETag/traffic所有確認を通して100%へpromoteします。

operatorはsource migration集合とchecksum ledgerを確認し、advisory transaction lockの内側でSQLを適用します。
baselineが無い、既適用SQLのhashが違う、元Supabase migrationへの対応が未確認なら停止します。
新SQLは旧app revisionとも互換にしてください。appのtrafficを戻しても、適用済みSQLを自動で逆実行しません。

## 更新直前バックアップと保持期限

未適用SQLが0件ならバックアップAPIは呼びません。1件以上の時だけ、同じlock内で
新しい [Backups.CreateBackup API](https://docs.cloud.google.com/sql/docs/postgres/admin-api/rest/v1/Backups/CreateBackup) に
固定instance・Tokyo・`ttlDays=14`・main SHAを含む固定markerを送ります。
完了後のresourceでSUCCESSFUL、同一instance/marker、残存期限1〜14日以内を検査してからSQLへ進みます。
TTLが未対応、無視された、期限が無い場合は停止します。実環境でのTTL確認は別gateです。

同じSHAのmarkerを完全にlistし、一意かつ15分以内に完了したbackupだけ再利用します。
古い・重複・pending/failedのbackupがあれば、同じ名前のbackupを増やさずoperator確認へ止めます。
完了時刻は必須で、時計ずれ許容は30秒です。新規作成時は今回のrequest開始以降であることも確認します。
このhelperは他のbackupを更新・削除しません。標準の無期限on-demand backupへfallbackしません。

必要IAMは `cloudsql.backupRuns.create/get/list` と `cloudsql.instances.get`（operation取得）です。
専用operator SAにだけ付け、通常deployerへSQL管理者権限を付けません。
[公式のAPI別permission表](https://docs.cloud.google.com/sql/docs/postgres/iam-permissions?hl=en) を参照してください。

## 検証

CIはfalse/true双方のcontainer build、隔離PostgreSQL baseline/復元、実PostgRESTのpool2での認可、
source freeze fixture、operatorのoffline planと各境界テストを実行します。
これらは架空データだけで動作し、実DB/Authの移行・復元・ログイン確認の代わりにはなりません。
最終source snapshotの作成と解除は[DB/Authバックアップ手順](./database-auth-backup.md)に分離しています。
