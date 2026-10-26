# Cloud Run の継続配信

`Deploy Production` に任意の Cloud Run job を追加した。**`GCP_DEPLOY_ENABLED` が文字列
`true` のときだけ有効**で、未設定 / false では WIF 認証もビルドも実行しない。
既存の Vercel 配信は移行期間中そのまま継続する。

## 有効化前の管理者作業

1. private 候補でログイン・既存データ・Server Action を検証する。
2. 公開と入口の切り替えを別途判断し、直接の Cloud Run URL で OAuth と閲覧を検証する。
   この workflow は IAM、invoker check、公開設定を変更しない。
3. [GCP bootstrap 手順](../../scripts/gcp/README.md)の `enable-production-wif.sh` を明示実行する。
   既存の main 手動候補経路に加え、`deploy-production.yml@refs/heads/main` の **push のみ**を許可する。
   repo / owner 数値 ID、main 制約は維持する。PR、別 workflow、手動 production 実行は許可しない。
4. 既存 `mfmf-candidate` への deploy SA の `roles/run.developer`、runtime SA の actAs、
   AR writer と対象 secret の VersionAdder を確認する。プロジェクト全体の Run 管理者権限や鍵は不要。
5. [固定参照 JSON](../../scripts/gcp/production-secret-versions.json)の3項目が実際の元値を持つ
   `ENABLED` version であることを、管理者が metadata と安全な保管元で確認する。
   ファイルは参照だけを含む。鍵の再生成、値の記載、`latest`、別 project、余分なキーは禁止。
   Server Actions 専用 `mfmf-next-server-actions-key` の固定 version と deploy SA の当該 secret
   accessor も確認する。既存の runtime 鍵とは別に生成した32 byte鍵を BuildKit secret で使う。
   詳細は[候補ビルド](./cloud-run-candidate.md#ビルドと出力)を参照。runtime SA へ権限を追加しない。
6. repository variable `GCP_DEPLOY_ENABLED=true` を設定する。以降の main push が配信対象となる。

有効化は管理者が行い、この変更の merge では flag / IAM / 実サービスを変更しない。
Cloud Run が private のままなら最初の匿名 GET が拒否され、ビルドや Cloud Run 更新前に停止する。

## 実行条件と更新の範囲

main push → 既存 CI → 暗号化 DB backup の artifact 保存 → Supabase migration の成功後だけ実行する。
Vercel 設定の取得・型と scope の検証・公開 Supabase キー検証・Docker 子環境の隔離は
手動 `prepare-candidate.mjs` と共通。main push はリポジトリの固定参照ファイルを Node が読み、
手動 workflow は従来どおり GitHub event の input を読む。任意の入力文字列を step env に展開しない。

対象は `mfmf-499612`（`92772745697`）、東京 `asia-northeast1`、既存 `mfmf-candidate` だけ。
現在の service UID / URI / etag、runtime identity、最小0・最大1、1 CPU / 512 MiB、
concurrency10、timeout60秒、Gen2、単一8080コンテナ、管理対象の環境変数を GET で検証する。
設定が違う場合は自動的に「修復」せず停止する。変更の要否を PR と実状態で確認する。

Cloud Run v2 API の `PATCH` は `allowMissing=false` と etag を指定する。
更新 mask は revision 名・containers・traffic、続く切り替えは traffic だけ。
service 作成、IAM、公開設定、リージョン、runtime identity、費用設定は変更しない。
資格情報は短期 WIF access token のみで、credential file / SA key / `gcloud` の認証保存は行わない。
API 本文・token・Docker出力・例外内容はログに出さない。

## 安全な切り替えと失敗時

1. 既存 service が Ready で、単一の healthy revision に100%配信されていることを確認する。
   split / tag 付き traffic、進行中の更新は拒否する。匿名 `/login` 200 と
   `/records/new` → 同一 origin の `/login` 307 も確認する。
2. 公開設定でイメージをビルド・pushし、固定 digest を取得する。ビルド中に service の
   etag が変わっていれば停止し、別の管理者の更新を上書きしない。
3. **旧 healthy revision に100%を明示固定したまま**新しい revision を作る。
   Ready、実 revision の digest、公開設定と固定 secret refs の一致を確認する。
   この段階で失敗・タイムアウトしても旧 revision の traffic は維持される。
4. 検証済み revision へ traffic を100%切り替え、反映と匿名 smoke を確認する。
   切り替え要求や smoke が失敗した場合は、同じ service / 作成 revision / digest と etag を
   再確認して旧 healthy revision へ traffic を戻す。
5. 成功時に公開設定・digest・secret version参照だけの artifact を保存する。

rollback 自体の権限 / API / 通信障害や外部同時編集があれば、復旧確認不能として job は失敗する。
この場合は実 traffic を管理者が確認する。盲目的な PATCH 再送や IAM の追加はしない。
artifact upload の失敗は、完了済みの healthy な配信を戻す理由にはしない。
切り戻すのは **アプリの traffic だけ**で、適用済みの DB migration や追加済み SecretVersion は戻さない。
破壊的 migration を含む場合は、旧 revision と新 DB の互換性・データ復元手順を別途確認する。
旧アプリが新 DB と互換であることは、Ready / 匿名 smoke だけでは証明できない。
この確認は匿名疎通と起動確認であり、Google / email 実ログインや DB 操作の E2E を置き換えない。

配信停止は `GCP_DEPLOY_ENABLED=false`。すでに進行中の job を取り消す設定ではない。
途中キャンセルせず、状態を確認して必要なら service traffic を管理者が戻す。

公式仕様: [Service PATCH](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.services/patch)、
[Service の reconciliation / traffic / etag](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.services)、
[Revision](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.services.revisions)、
[Container / secretKeyRef](https://docs.cloud.google.com/run/docs/reference/rest/v2/Container)。
