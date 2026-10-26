# GCP移行前の棚卸し

P1の配信検証の次に、[段階移行計画](../explanation/gcp-migration.md)のP2（ファイル）・P3（DB）で変更する入口を確認する。
Identity Platformへの認証置換はP4。**この手順は移行実行でも、移行可能性の合格判定でもない。**

## ソースだけを確認するCLI

```bash
node scripts/gcp/migration-inventory.mjs
node --test tests/scripts/migration-inventory.test.mjs
```

Node 22と既存のTypeScript依存を使う。gcloudやDB資格情報は不要。
CLIはGit管理下の `src/`・`scripts/` のTS/JS、`supabase/migrations/`・`supabase/tests/` のSQLを読み、
コード位置と識別子だけをJSONへ出す。アプリをimportせず、ネットワーク・DB接続・資源作成は行わない。
実envは読まず、対象外の拡張子・未追跡ファイル・symlinkを拒否/除外する。
引数で任意ファイル・SQL・接続先を渡す機能も無い。CLIのテストは一時Gitリポジトリと架空のソースだけを使う。

出力を固定の一覧としてコミットしない。変更後に再実行する。
`revision` はHEADの識別子で、内容は現在の作業ツリーを読むため、未コミット変更があればHEADそのものの解析結果ではない。
初回追加のソースは `git add` 後に対象になる。正常終了は読み取りと解析が完了した意味に限る。

| 出力 | 用途と限界 |
| --- | --- |
| `calls` / `imports` | ASTから `.from`・`.rpc`・`.auth`・`.storage` の構文候補と行番号を抽出。型解決していないので別SDKの同名メソッドも候補になり、wrapper・別名・destructureは漏れ得る |
| `target.kind: unresolved` | 定数・変数・識別子以外の文字列。値を出さず人がコードを確認する。`PHOTO_BUCKET`等の定数も自動解決しない |
| `dynamicMembers` | `client[method](...)` 等の動的な呼出位置。Supabase呼出と断定しない |
| `sqlReferences` | `auth.*` / `storage.*` の既知の依存名だけを字句照合。SQL本文・文字列値は出さない。コメント/文字列内やDROP済みの履歴も含むため、実効スキーマ・生きたRLSの一覧ではない。引用識別子・動的SQLも網羅しない |
| `pgTapFiles` / `shellScripts` | 維持・移し替えのレビュー入口。SQLテストを実行した結果ではなく、shell中の実装は解析しない |
| `readiness: not-assessed` | 件数ゼロでも準備完了ではない。DB内容、UID、IAM、オブジェクト整合性、ランタイムの認可は一切検証していない |

生のHTTPでSDKを経由しない保守コマンド、生成コード、未追跡ファイル、関数を跨ぐデータフローは別途レビューする。
コードの棚卸しを本番のデータ件数・写真の数・移行後の動作確認の代用にしない。

## P2は「署名関数の中身だけ交換」から始めない

現行 `src/lib/photos.ts` / `src/lib/avatars.ts` はパスを受け取ってSupabase Storageへ署名を要求する。
その時点でもStorage RLSが利用者を検査する。GCSの実行SAはバケットのオブジェクトを扱えるため、
同じ引数のままGCS signerへ差し替えると、この認可を失う。

最初のアプリ改修は**Supabaseを使い続けるまま、操作別の認可境界をテスト可能にする**単位にする。
汎用の `sign(path)` / `upload(path)` をClient ComponentやServer Actionの公開入口にしない。

| 操作の入口 | 認可の起点と契約 |
| --- | --- |
| 写真読取 | 認証済み利用者がRLS経由で取得した `record_photos` の行に結び付いた内部descriptorだけを署名する。クライアント申告のpathを署名へ直通させない。画像は現在どおり世帯メンバーに限定し、本文・ペットのゲスト閲覧許可を画像へ拡張しない |
| アバター読取 | profile / household / petの別々の参照元をRLSで取得する。2bucket・4参照元の区別を残し、Google外部avatar URLとアップロード画像を混同しない |
| 新規写真PUT予約 | 画面が対象にした世帯IDのメンバーシップと編集権を検証し、サーバーでrecord ID・path・サイズ・MIME・期限を結び付ける。「現在世帯cookie」だけに頼らない |
| 既存写真追加 / 削除 | 対象の記録/写真の世帯・書込権限を起点にする。パスのprefixだけで権限と存在を判断しない |
| アバター更新 | 本人profile・編集可能な対象household/petを分ける。#150のviewer書込拒否を後退させない |
| PUT完了 | 認可を再検証し、予約対象・実サイズ・MIME・generationを照合してからDBへ登録する。失敗時は孤児を管理し、無条件に成功としない |

descriptorは型のブランドだけで安全になるものではない。生成する関数をサーバーの認可済み経路に閉じ、
ブラウザからのJSONをcastして通さない。SDKを呼ぶadapterは認可を実施する層の内側に置く。
最初のPRは既存Supabase実装で契約を固定し、GCSへの切替・署名発行・クラウドIAM変更を混ぜない。

次のPRでGCS読取adapterを追加するときも、**対象行の認可後にオブジェクト存在を確認**する。
署名生成の成功を存在確認に使わない。存在しない場合だけSupabaseへfallbackし、403・timeout等を
「見つからない」に変換して権限/障害を隠さない。切替期間の削除も両系統で扱う。

PUTの実GCS契約試験には、署名されたXML APIヘッダ `x-goog-if-generation-match: 0`、CORS、サイズ上限、
同一URL再使用、削除後の再PUT、完了前後の競合を含める。エミュレータだけの成功でIAM/signBlobまで確認済みにしない。
この試験やbucket作成は今回のCLIに含まれない。

## データ照合とP3を独立させる

P2の次の小単位として、[オフライン画像照合器](./storage-manifest-reconciliation.md)を用意した。
架空manifestだけで、写真/アバターの両bucketと4参照元の欠落・余分・size/hash不一致・比較不能・削除tombstoneを区別できる。
共通hashがないものは「一致」で通さず、ETagをMD5へ推定変換しない。
入力metadataの比較だけなので、実データの取得・整合したsnapshot・認可・復元の検証を代替しない。
実データの採取・copy/sync・delete・掃除は別の手順で、照合器に実行機能はない。

P3はその後、ローカルの隔離DBでauth互換shim・所有者/ロール・transaction限定claimsと既存pgTAPを検証する単位にする。
既存Supabase migrationは改変せず、再生可能な別baselineを検討する。
`delete_own_household` の現行定義は予定migrationにもあり、Storageだけ除いて予定のガードを落とさない。
Storageを読む4つのpgTAPはアプリの認可契約へ移し、残りを素のDBで維持する。ダミーStorage表で通過させない。
P3〜P4の間も認証はSupabaseなので、検証済みidentityの同期をP3側で扱う。

現行の暗号化バックアップはpublicスキーマとそのデータが対象で、**auth.users / auth.identitiesとStorageオブジェクト本体は別途保護が必要**。
復号の成功はアプリ全体の復元成功ではない。P3の合格条件には、UID/provider対応を保った認証データ、
両bucketのオブジェクトと参照、DBデータ・RLS・予定機能を合わせた復元リハーサルを含める。
ローカルの隔離PostgreSQLで先に架空データを使って確認し、本番コピーの取得や復号をこのCLIへ追加しない。

本番DBのコピー、Cloud SQL作成、Identity Platformの一括import、Auth切替、旧サービス削除は、この棚卸しの後に自動実行しない。
予算3,000円は停止スイッチではないため、課金資源は検証準備ができた段階で別途作成する。
