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
TTLが未対応、無視された、期限が無い場合は停止します。

**現在のStandard構成では、未適用SQLを含む通常配信は停止します。** 2026-10-29の実検証では
`ttlDays=14` を送って作成に成功しても、取得したresourceの `expiryTime` はNULLでした。
[Standard on-demandの保持仕様](https://docs.cloud.google.com/sql/docs/postgres/backup-recovery/backup-options#backup_retention_2)も、
明示的な削除まで無期限です。`ttlDays` の送信だけで14日後の削除を保証しません。
未適用SQLが0件の通常配信と、個別に復元・保持を確認する初回切替はこの制限の対象外です。

同じSHAのmarkerを完全にlistし、一意かつ15分以内に**開始した**backupだけ再利用します。
古い・重複・pending/failedのbackupがあれば、同じ名前のbackupを増やさずoperator確認へ止めます。
開始・完了時刻は両方必須で順序も検査し、時計ずれ許容は30秒です。新規作成時は今回のrequest開始以降であることも確認します。
[API仕様](https://docs.cloud.google.com/sql/docs/postgres/admin-api/rest/v1/Backups)では、開始時刻までの書込が収録されるため、
完了が最近という条件だけで古いbackupを再利用しません。

固定instanceの全ON_DEMAND backup（他markerを含む）は8件、`maxChargeableBytes` 合計1 GiBを上限にします。
一覧不完全、未知の型・容量、上限超過で止め、新規作成には件数・容量の空きが必要です。
作成後・再利用前にも取得したresourceの容量を検査します。AUTOMATED / FINALはこの手動backup枠に含めません。
これは作成を抑止する検査であり、請求の厳密な上限ではありません。新規backupの容量は完了後に判明し、
別operatorの同時操作や後の容量変化もあり得ます。超過時に復元点を自動削除しません。

現在、このhelperはbackupを更新・削除しません。無期限backupを許可してSQLへ進むfallbackもありません。
初回移行の手動backupは、復元・全行照合と後続の復旧点を確認してから、固定IDを指定した別の承認済み操作で整理します。
容量を空ける目的だけで必要な復旧点を早期削除しません。自動backupの保持14件は手動backupの期限にはなりません。
通常SQL更新の開放には、別変更で固定対象・専用marker・14日経過・新しい有効な復旧点の存在を確認する
明示的な保持/削除手順と実環境検証が必要です。この変更では削除権限やcleanup schedulerを追加しません。

必要IAMは `cloudsql.backupRuns.create/get/list` と `cloudsql.instances.get`（operation取得）です。
専用operator SAにだけ付け、通常deployerへSQL管理者権限を付けません。
[公式のAPI別permission表](https://docs.cloud.google.com/sql/docs/postgres/iam-permissions?hl=en) を参照してください。

## 検証

CIはfalse/true双方のcontainer build、隔離PostgreSQL baseline/復元、実PostgRESTのpool2での認可、
source freeze fixture、operatorのoffline planと各境界テストを実行します。
これらは架空データだけで動作し、実DB/Authの移行・復元・ログイン確認の代わりにはなりません。
最終source snapshotの作成と解除は[DB/Authバックアップ手順](./database-auth-backup.md)に分離しています。
