# GCP の本番監視と運営画面

Cloud Hub のプロジェクト表示を運営の入口にし、Cloud Monitoring の専用dashboardに障害・DB・日次保全をまとめます。
費用はCloud Hub/Billingへのリンクで確認し、メトリクスへ転載しません。API設定の保存、監視の実測、通知の到達は別の受入です。
このガイドだけを根拠に、本番設定やメール到達が完了したとは判断しないでください。

共通の運営Issueは非公開 [`godhuu0505/app-operations`](https://github.com/godhuu0505/app-operations/issues) に集約します。
mfmf・mnmn・wkwkと今後追加するアプリの共通入口です。監視対象を取り違えないよう、このdashboard・policy・Jobの
`mfmf` 名と固定projectは維持します。他アプリのGCP資源をこのbootstrapへ自動追加するものではありません。

## 固定対象と通知条件

`scripts/gcp/bootstrap-observability.mjs` は project `mfmf-499612` / number `92772745697` に固定しています。
IAM、アプリ、DB、Scheduler、バックアップ、Sentryの設定は変更しません。
既存のLogging/Monitoring APIを確認し、Cloud Hubの費用・利用状況表示に必要な `appoptimize.googleapis.com` だけを有効化します。
App Hubへの登録、新しい管理project、Recommender、Gemini、BigQueryは追加しません。
[Cloud Hub設定](https://docs.cloud.google.com/hub/docs/setup-cloud-hub)を参照してください。

| 通知 | 条件と限界 |
| --- | --- |
| 公開ログインの外部到達 | 固定run.appの `/login` に認証なしHTTPS GET、200のみ成功、TLS検証あり。15分間隔・Asia Pacific / Europe / Oregonの3地点、timeout30秒。直近20分の最新結果で2地点以上失敗が1分継続。検出は即時ではなく、通常次の15分チェック＋通知処理を待つ。ログイン後のDB/RLS動作は別検証 |
| アプリ障害 | 固定Cloud Run serviceの5分間の5xxが3件以上。リクエストがない時間の可用性は外部チェックが担当 |
| DB停止・監視欠落 | 固定Cloud SQLの直近5分に `up=1` がない。メトリクスが届かない場合も通知対象 |
| DB容量 | ディスク利用率80%超が15分継続。自動増設やデータ削除は行わない |
| バックアップ失敗 | 固定2 Jobそれぞれで直近20分に成功以外の終了結果が1件以上。キャンセルも対象。SchedulerのHTTP成功とは区別 |
| IdP保全の成功欠落 | `mfmf-identity-backup` が30時間成功していない。空系列を0件として検知 |
| SQL保持の成功欠落 | `mfmf-db-retention` が30時間成功していない。もう一方の成功で欠落を隠さない |

通知先は運用者が確認したメール1件です。開いたincidentは6時間間隔で再通知します。
障害時はExecution/現在revision/固定stage等を確認し、未知の書込結果を盲目的に再実行しません。
Jobの成功は独立復号・実復元や暗号文の最新性すべてを証明しないため、[日次保全の受入・復旧手順](./gcp-backup-automation.md)を維持します。

## 30時間欠落の方式

通常の[metric-absence](https://docs.cloud.google.com/monitoring/alerts/metric-absence)は最大23.5時間なので、日次Jobの30時間判定には使いません。
標準 `run.googleapis.com/job/completed_execution_count` はDELTA/INT64です。Job/地域/project/resultを固定し、
`sum(sum_over_time(metric[30h])) or vector(0)` を1未満と比較します。累積カウンタの増加率や、単なる系列の存在とは区別します。
成功0のsampleがあっても成功とせず、各Jobを別policyにします。PromQLの比較には `bool` を付けません
（値が0でも系列が返るとalertの条件になるため）。

25時間超の標準メトリクス照会は[拡張PromQLのPreview](https://docs.cloud.google.com/monitoring/alerts/using-promql)です。
評価間隔300秒・retest0秒とし、custom/log-based metricの25時間上限を回避します。Previewの可用性や仕様変更は運用上の限界です。
bootstrapは実APIで30時間分の生DELTA合計と同じPromQLの値、空系列fallbackを照合してから変更します。
照会拒否・不完全応答・不一致なら設定前に停止します。2026-10-29の読取試験では両Jobとも疎な2点(0,1)から合計1件となり、PromQLも一致しました。
全6 PromQL条件はHTTP200で評価でき、当時の発火系列は0件でした。これは継続監視やメール到達の証明ではありません。

## 計画・適用・再実行

```bash
node scripts/gcp/bootstrap-observability.mjs --plan
# operator wrapperからGCP_ACCESS_TOKEN/MFMF_ALERT_EMAIL等をメモリで渡す
export MFMF_PRIVATE_FEEDBACK_REPOSITORY=godhuu0505/app-operations
node scripts/gcp/bootstrap-observability.mjs --inspect
node scripts/gcp/bootstrap-observability.mjs --apply
```

既定planは認証情報もネットワークも使いません。inspectはGETだけです。applyだけがAPI有効化、email channel1件、
dashboard1件、uptime check1件、alert policy7件を作ります。API有効化のpollは最大60秒、HTTP timeout30秒、
応答2MiB、一覧10page/1,000件までで、不完全な一覧を空とみなしません。

通知メールは `MFMF_ALERT_EMAIL`、費用リンクの請求accountは `MFMF_BILLING_ACCOUNT_ID`、非公開Issueの `owner/repo` は
`MFMF_PRIVATE_FEEDBACK_REPOSITORY=godhuu0505/app-operations` で渡します。通知メール・請求account・token・API本文を
出力・リポジトリ保存しません。共通Issue repoは運用者が非公開のアクセス制御を確認して指定します。
公開の `godhuu0505/mfmf` はfeedbackリンクとして拒否します。
Sentryリンクは組織選択画面であり、Sentryが設定済みであることを意味しません。

既存の同名/所有label付き資源は内容を厳密照合し、一致時だけ再利用します。変更、無効化、宛先追加、重複は停止条件です。
PATCH/DELETEやIAM grantは行いません。必要な権限は既存operatorのproject取得、Monitoring各資源list/create、
timeSeries読取、Service Usage get/enableです。新SA・鍵・roleを作りません。

一度のapplyを運用者が排他的に実行してください。POST失敗・応答不明は自動再送しません。
部分作成後はまずinspectで状態を確認し、同名資源が一意・一致であることを確認してから再実行します。
他operatorとの作成競合を原子的には防げないため、並行applyは禁止です。
既存資源の意図した編集も自動修復せず、reviewした変更として別途扱います。

## 適用後の受入

1. inspectで固定資源・通知先・条件が一致することを確認する。`UNVERIFIED` channelは成功としない。
2. Cloud Hubのproject表示でHealth/Optimizationを開き、dashboardの費用/予算/Issueリンクが正しくアクセス制御されることを確認する。
   Cloud Hubは通常1日程度、時に24時間超遅延し、最大30日・原則クレジット適用前の費用を表示する。
3. 次の外部チェックで3地点の200/TLS成功が揃うことを確認する。設定保存だけを外部到達成功としない。
4. 通知先本人の受信を別途確認する。[公式通知テスト手順](https://docs.cloud.google.com/monitoring/support/notification-options#testing)
   のとおり一般的なemail channelのテスト送信機能はない。アプリを故障させず、明示した一時的な試験policyでincidentを発生させ、
   受信と復帰を確認して試験policyを撤去する。bootstrapから試験メールやverification codeを自動送信しない。
5. 次の日次実行と「成功なし」の試験条件、既存3,000円予算の50/90/100%通知先を確認する。
   費用反映には遅延があり、予算メールは支出上限の強制装置ではない。

## 費用

[Cloud Hub](https://cloud.google.com/hub/pricing)は無料。GCP標準metricとConsole dashboardに追加料金はなく、
[Logging](https://cloud.google.com/products/observability/pricing)はproject毎50GiB/月まで無料、超過$0.50/GiB、
30日超の保持は$0.01/GiB月です。既存_Default30日/_Required400日を変更しません。custom metricや外部分析基盤は追加しません。

uptimeは31日×24時間×4回×3地点=8,928実行/月で、Monitoringのproject毎100万回無料枠内です。
Cloud Runへの起動・処理・通信費は別です。無料枠なし、1CPU/1GiB、各実行1秒、157.195円/USD・税10%なら約41.53円/月、
2秒なら約82.44円、5秒なら約205.17円。起動時CPU boost・ネットワーク等も増え得るため100円上限は保証しません。
[Run料金](https://cloud.google.com/run/pricing)と[CPU boost](https://docs.cloud.google.com/run/docs/configuring/services/cpu#startup-boost)を確認し、
監視導入前後の実請求とinstance起動回数で再評価します。

Cloud Monitoring alertingの課金開始は早くても2027-09-01。予定はmetric reference毎$0.35/月＋照会100万点$0.50です。
Uptime metricのalertingは課金対象外ですが、残る6参照は同換算で約363円/月＋照会料金となります。
料金改定前に構成と予算を見直してください。現時点の無料を永続条件にしません。
