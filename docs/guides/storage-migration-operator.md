# GCS画像移行のoperator手順

対象は固定Supabase projectの写真/アバターと4参照元、固定GCP project `mfmf-499612`の
`mfmf-499612-photos` / `mfmf-499612-avatars`。DB/Auth自体の移行は含まない。
[暗号化Storageバックアップ](./storage-operator-backup.md)と
[media ledger](../reference/media-storage-ledger.md)を先に読む。
アプリの実行SAへSupabase管理キーを渡さない。

## 実行境界

`storage-migration.yml`はmain専用。専用WIF pool/provider `mfmf-storage/github-storage`と
`mfmf-storage-operator@mfmf-499612.iam.gserviceaccount.com`だけを使用する。
repo/ownerのnumeric ID、main、workflow path、manual/schedule eventをproviderで固定する。
既存deploy provider/SAを流用しない。権限は2bucketのgetとobject操作で、RunやIAMを変更できない。
workflow変数は`GCP_STORAGE_WIF_PROVIDER` / `GCP_STORAGE_SERVICE_ACCOUNT`。

Supabaseの固定Management SQL APIでは`parameters`で値を束縛し、自由入力SQLを実行しない。
Storageの既存legacy keyは一時operatorメモリのGETだけで使用する。GCS tokenもメモリだけで使い、
redirect・任意project/bucket/URL・無条件上書き・元画像削除は実装しない。
出力は操作名・固定状態・集計のみ。行ID、path、画像、hash、token、例外/HTTP本文は出さない。

mode変更と移行は`deploy-production` groupで直列化する。
GitHubのpendingは1枠なので、**実行中/待機中のproduction runが無い時だけ手動dispatch**する。
外部operatorのSQL・移行・Storage変更を同時に走らせない。
SQL内のrow lockとCASは個々の競合を拒否するが、lock待機前のMVCC snapshotを使う同statementが
別operatorによる行追加を網羅的に検出する保証にはしない。運用の排他も必須。
日次/manual cleanupは専用groupで、待機中の配信を置き換えない。

## 手動mode

| mode | 操作と成功後の状態 |
| --- | --- |
| `plan`（既定） | readonly rich snapshotから集計。GCS資格情報の取得・書込・mode変更なし |
| `migrate` | supabase→frozen、fresh暗号化backup、参照ごと新UUIDのGCS copy、全件SHA256再読、legacy ledger INSERT。**参照pathは旧値、read_backendはsupabaseのまま** |
| `activate` | 独立復元gateを人が確認し`restore_verified=true`。全final generation/metadata/SHA256を再検証後、4参照元CASとmode/read_backend=gcsを同じDB statementで反映 |
| `rollback` | stagedまたは初回activate後に限定。全legacy source SHA256を確認し、必要なら4参照元inverse CASとmode/read_backend=supabaseを同じstatementで反映。旧画像は残す |
| `abort-staging` | ledger commit前の失敗からの明示復帰。frozen/read_backend=supabase、ready/reservedゼロ、参照asset IDすべてnull、欠落ゼロ、fresh完全backup・snapshot不変を確認してsourceへ戻す。**GCS orphan回収は未評価のまま残る** |
| `cleanup` | expired reservedをDBでterminalにし、deleted ledgerのfinal/incomingだけをgeneration指定で回収。mode/read_backendを変えない |

`migrate`は1プロセス内で完結する。age復号鍵をCIへ置かないため、暗号化planを後続CIで復号して
無条件再開する設計にはしない。1件10MiB/アバター2MiB・5画像MIMEを超える既存objectは停止する。
共有pathは参照ごとに別asset/keyへ複製し、photo行ID・record ID・owner/household・画像以外の列を保持する。
GCS incoming uploadは`ifGenerationMatch=0`、final rewriteはsource generationとdestination create-onlyを指定する。
8項目のserver binding metadataを置換し、final generationを指定した全byte SHA256で照合する。
同じbufferを暗号化backupとcopyへ使うため、backup後にsourceを読み直して別内容へ差し替えない。

snapshotは2bucket metadataと4参照元の行/親ID・owner/household・旧path・asset ID、ledgerを含む。
legacy ledgerには旧path、元参照行ID、期待SHA256をimmutableに保持し、created_byはNULL。
`activate`と`rollback`は全件CAS失敗でtransaction全体を失敗させる。modeだけ先に変更しない。
通常のGCSユーザーuploadが1件でも発生した後のrollbackは拒否する。以後は新画像を保つ別の逆同期が必要。

**Storageの進行中uploadの収束も切替gate。** metadataの前後一致やtable lockだけで、
既に認可されたuploadのbody転送・managed admin completionまで止まったと断定しない。
実Storage版とmode guardを確認し、後発metadata変更が拒否されることを検証してから実移送へ進む。
本体/DB間の原子的snapshotや復元合格を、件数・署名生成成功だけから推定しない。

## 失敗時と暗号化receipt

各stage/観測generationを`receipt.age`へ暗号化してatomicに更新する。`snapshot.age`と完成済み`backup.age`も
暗号文だけを90日Artifactへ保存する。部分暗号化ファイルや平文はアップロードしない。
失敗後は自動unfreeze/自動rollbackしない。応答喪失は`failed-or-unknown`であり、DB未commitとは断定しない。
CI中断後はmode、read backend、参照、ledgerと暗号化receiptを確認する。

- ready ledgerがある場合、`abort-staging`は拒否する。staged/activeを確認し、通常の`activate`または`rollback`へ進む。
- ledgerが無いcopy途中失敗なら、`abort-staging`でsource書込を再開できる。これは掃除完了ではない。
- receiptのplanned UUIDと観測generationに結び付くGCS残骸は別途回収する。全bucket sync/deleteはしない。
  finalはbindingの全項目、期待SHA256、現在generationを照合し、対象generationだけを削除する。
  DB commit結果不明・参照あり・binding不一致・未知内容なら削除せず調査する。
- ledger無しorphanは日次cleanup対象外。`_incoming/`は1日lifecycleがあるがfinalは自動消去されない。
  回収が残る場合は未完了として扱い、暗号化receiptを破棄しない。

## 独立復元リハーサル

鍵保持者のlocal環境で、専用operator SAをimpersonateできる一時権限を用意する。
tokenは固定gcloudのstdoutをメモリで受け、HTTPログを無効にする。復号鍵はCIへ渡さない。

```bash
set -o pipefail
age --decrypt --identity /protected/local/age-identity.txt /protected/local/backup.age \
  2>/dev/null | node scripts/gcp/restore-storage-backup.mjs --apply
node scripts/gcp/probe-storage-soft-delete.mjs --apply
```

`--apply`無しはcloud操作をしない。restoreは全archiveを検証してから新しい`_incoming/UUID`へ全本体を復元し、
返却generationの全SHA256確認、同generation削除・不存在確認を行う。元pathやfinalkeyを宛先にしない。
**ageとNodeの両exit0を確認する。** Node単独の成功は上流復号の最終認証成功を証明しない。
soft-delete probeは架空40byteを1件だけ使い、delete→元generationを`ifGenerationMatch=0`でrestore→
新generation/body hash確認→新generation限定deleteを行う。
ネットワーク応答喪失やabortで未回収incomingが残る可能性は失敗として扱い、1日lifecycleを後備とする。
soft deleteで保護中のbyteは即時の物理消去ではなく7日課金に含まれる。

## 定期保守と検証

03:00 JSTのscheduleはコード・workflow両方で**cleanupだけ**に固定する。移行・activate・rollbackへ分岐しない。
expired reservedはまずDB terminal化する。final generationがledgerにある場合は完全一致、nullの場合も
final metadataのserver binding全項目一致を確認し、現generationを特定して削除する。
不明binding/別generationは削除しない。失敗件数があればjobを失敗させ、terminal状態のまま次回再試行する。
件数はkeysetで200件ずつ、1run最大10,000 assets/20分に制限する。active/ready assetは対象外。

架空API fixturesに加え、CIはlocal Supabaseから**schemaだけ**を一時DBへ複製し、実ledger trigger上で
stage・stale CAS拒否・同時activate・inverse rollback・staged cancellationを検証する。
既存localの行を変更せず、fixture DBは終了時に破棄する。

一次資料: [GCS rewrite](https://docs.cloud.google.com/storage/docs/json_api/v1/objects/rewrite)、
[generation preconditions](https://docs.cloud.google.com/storage/docs/request-preconditions)、
[soft-delete restore API](https://docs.cloud.google.com/storage/docs/json_api/v1/objects/restore)、
[Management SQL API](https://supabase.com/docs/reference/api/v1-run-a-query)。
