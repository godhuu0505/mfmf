# Storageの運用専用バックアップ

P2の画像移行に先立ち、現在のSupabaseにある写真・アバターの本体を保全する。
通常のDBバックアップにはStorage本体が入らないため、別の手動workflowを使う。
GCSへの移送と隔離復元は、別の[operator手順](./storage-migration-operator.md)で扱う。
**本手順はコピー・本番切替・完全な復元の合格判定ではない。** GCSへの書込、元の削除、DB参照更新、
アプリの認証/認可変更、Authユーザーのバックアップは含めない。

## 実行する範囲

GitHub Actionsの **Back up Supabase Storage** を`main`で手動実行する。
既定の`inventory`を先に実行し、数量・容量を確認してから`backup`を実行する。
`production` Environment、既存の`SUPABASE_ACCESS_TOKEN` / `SUPABASE_PROJECT_ID`と、
公開age受信者`SUPABASE_BACKUP_AGE_RECIPIENT`だけを利用する。DB password・GCP資格情報は不要。
`deploy-production` concurrency groupでmigrationとは直列化するが、アプリからの更新を止める機能はない。
GitHubの同groupのpendingは1枠なので、**productionの実行中/待機中runが無い時にdispatchする**。
`cancel-in-progress: false`でも新しい待機runは既存pendingを置き換え得るため、配信待ちの列へ割り込ませない。

接続先は公開アプリのSupabase URLに一致する`aqvmuhqkaqedtxuqwhoq.supabase.co`に固定する。
Environmentのproject refが一致しなければ接続しない。任意URL/SQL/bucket/pathを実行引数に渡せない。

| モード | 読み取り | 保存・出力 |
| --- | --- | --- |
| `inventory` | 同じ固定SELECTを2回。`storage.buckets`、`storage.objects`、DBの4参照元 | 標準出力は件数・合計byte・未参照・欠落・共有pathの**件数のみ**。キーや画像本体は取得しない |
| `backup` | 同じSELECT→API key取得→列挙済みobjectのGET→同じSELECT | 本体をSHA256計算し、完全manifestとともに直接ageへ渡す。保存するのは暗号文だけ |

写真bucketは`daycare-photos`、アバターbucketは`avatars`。
参照は`record_photos.storage_path`、`profiles.avatar_path`、`households.avatar_path`、`pets.avatar_path`。
世帯/ゲスト/旧owner形式を含め全objectを対象にする。未参照objectも保全し、自動削除しない。
同じpathの複数DB参照は`sharedPaths`として数える。avatarの`null`は未設定で、写真のnull/空文字とは区別する。
2bucketが両方存在しprivateであること、SQLがread-only transactionでRLS bypass可能な実行主体であることを
返り値で検査する。権限不足による空一覧をバックアップ成功にしない。空object一覧のbackupは失敗する。

SQLは固定の単一SELECTで、APIへ`read_only: true`を要求する。
1回のSELECT内でmetadataと4参照元のMVCC snapshotを共有する。
件数上限の1行先まで取得し、超過を黙って切り捨てない。完了後に同じSELECTを再実行し、
bucket設定・全objectの名前/世代/作成更新時刻/metadata・全参照配列を厳密比較する。
読み取り自身で変わり得る`last_accessed_at`は比較しない。

上限はobject 1,000件、1件32MiB、合計256MiB、JSON応答1MiB、object metadata 8KiB。
将来のコピー先を含めて[照合器](./storage-manifest-reconciliation.md)の合計5,000エントリ以内に制限する。
ネットワーク1要求60秒、全体20分、workflow25分。並列ダウンロード・自動retryはない。
上限・応答schema・権限・差分検査に失敗したら、理由の生値をログへ流さず固定エラーで停止する。
増量が必要なら、先に容量/費用と検出範囲をレビューして上限を変更する。

## 運用キーと平文を残さない

全件保全には通常の利用者JWTでは見えないobjectも必要になる。
このworkflowだけはManagement APIの`GET api-keys?reveal=true`で既存のlegacy `service_role` JWTを取得し、
source project/role/期限を確認して、同じNodeプロセスのStorage GETに限って使う。
キーの作成/ローテーションはしない。legacy keyが無い・複数候補がある場合は停止し、新しいsecret keyを推測で選ばない。

これは**アプリruntimeがservice roleを使う設計ではない**。`src/`・ブラウザ・Cloud Run・GCSへキーを渡さない。
キー・PATはログ/例外本文/ファイル/manifest/子プロセスのenvやargvに入れない。
Nodeのメモリからの完全な消去保証はないので、実行は一時GitHub runnerに閉じ、debug/heap dumpを使わない。
HTTP redirectは追従せず、失敗時はレスポンス本文を読まず破棄する。

S3キー新規発行も全bucketの操作権限とRLS bypassを与えるため、読み取り限定の鍵の代替にはしない。
Supabase CLIのcpは個人pathをログへ出し平文ファイルを作るため、ここではNodeの固定GETを使う。
object名は大小文字・Unicode・percent文字・旧owner prefixを変換して同一視しない。
ただし空segment・`.` / `..` segment・backslashを含む名前はHTTP経路での曖昧さを避けて停止し、
別のaddressingレビューを求める。勝手な除外や正規化はしない。

ageには公開受信者と平文のstdinだけを渡す。暗号化前に受信者を実ageで検査し、
暗号化ファイルはprivateな一時directoryに0600で作る。
全件取得・前後一致・暗号化正常終了の後だけ、固定名`storage-objects.mfmf.age`を公開可能な出力directoryへ移す。
既存directoryは上書きしない。失敗時は作った一時ファイルを片付け、Artifact uploadを行わない。
GitHubにアップロードするのはこの暗号文1ファイルだけ、保持90日。
公開リポジトリのArtifactは取得され得るため、復号鍵をGitHub/CIへ登録しない。

## 復号後の全件byte検証

archiveはversion付きbinary framingで、初期snapshot、連番ごとの本体とSHA256、完了footerを持つ。
footerの`manifest`は既存照合器のshapeそのもの（`source`にSHA256、`destination: []`、4参照元、`tombstones: []`）。
provider version/metadataは暗号化headerに保持する。ETagをMD5として扱わない。
既存の削除履歴をDBから取得する仕組みは無いので、空tombstonesは「削除が無い証拠」ではない。

復号鍵の保持者が隔離環境で次を実行する。鍵のパスとarchiveはローカルの保護された場所を選ぶ。
**生の復号内容をterminalへ表示したり、通常のファイルへredirectしない。**

```bash
set -o pipefail
age --decrypt --identity /protected/local/age-identity.txt /protected/local/storage-objects.mfmf.age \
  2>/dev/null | node scripts/gcp/verify-storage-backup.mjs
```

**ageとNodeの両方が終了0であること**を確認する。Nodeの結果だけではageの最終認証に成功したとは言えない。
検証器は復号stdinのみを読み、ファイル展開・ネットワーク・資格情報取得を持たない。
全本体のSHA256/size、順番、manifest、snapshot digest、完了footer、末尾の余分なbyteまで検査する。
出力は件数と容量のみ。秘密/元path/filename/本体/hashは出さない。
架空の2bucket/4参照元と実ageの暗号化・復号、改変/途中切断/末尾追加・失敗時非公開をCIで検証する。
さらにCIのlocal Supabase起動後に`node tests/scripts/storage-backup-local-sql.mjs`を実行し、
実migration適用済みschema上のread-only transactionで固定SQLを検証する。
これにより、例えば`profiles`のキーが`id`ではなく`owner_id`であることをSQL実行で確認する。
SQL testは固定local Docker socketの`supabase_db_mfmf`だけを使い、結果の値を出力しない。

## 切替と復元の未達gate

前後metadata一致は、Storage本体とDBの原子的snapshotを証明しない。
ダウンロード途中の更新、遅延PUT、削除と同名再作成、CDNの旧内容などをこの方式だけでは排除できない。
archive検証成功は保存したbyteの再読と整合に限り、source最新版との一致・画像表示・認可・完全復元を保証しない。
`readiness`は常に`not-assessed`。

本番切替には別途、両配信元・古いタブ・直接Storage APIを含めたwrite freezeと進行中uploadの収束、
固定GCS宛先へのcreate-onlyコピー、実generationを指定した全件readback SHA256、
隔離prefixでの復元と認可済み画像表示、切替直前の全参照照合が必要。
新GCS書込後に旧アプリへ戻す場合は、現在のDB参照と追加画像を保った逆同期を先に検証する。
古いDB snapshotへ戻したり、元画像を削除/上書きしたりする操作をこのworkflowへ追加しない。
実容量・二重保管・暗号化backup・検証読取のegressも月額枠に含めて確認する。

一次資料: [Management SQL API](https://supabase.com/docs/reference/api/v1-run-a-query)、
[API keysのGET](https://supabase.com/docs/reference/api/v1-get-project-api-keys)、
[Storage metadataと本体の分離](https://supabase.com/docs/guides/storage/schema/design)、
[S3認証の権限](https://supabase.com/docs/guides/storage/s3/authentication)、
[S3互換性とversioning非対応](https://supabase.com/docs/guides/storage/s3/compatibility)、
[PostgreSQLのsnapshot](https://www.postgresql.org/docs/current/transaction-iso.html)。
