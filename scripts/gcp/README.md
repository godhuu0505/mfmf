# GCP 初期構築（管理者による一度限りの作業）

`bootstrap.sh` は既存の、課金が有効なプロジェクトに Cloud Run の土台を追加する。
**引数だけでは計画表示になり、Google Cloud を呼ばない。** 適用は `--apply` を明示する。
実 env ファイル、秘密値、サービスアカウント鍵は使わない。

```bash
bash scripts/gcp/bootstrap.sh \
  --project PROJECT_ID \
  --project-number PROJECT_NUMBER \
  --billing-account BILLING_ACCOUNT_ID
# 表示された対象を確認した管理者だけが、同じ引数に --apply を追加する。
```

必要なローカルツールは Bash、gcloud、jq。gcloud は管理者本人で認証する。
プロジェクト ID と数値 ID、リンク先の課金アカウントを照合してから変更する。
既定の gcloud プロジェクト設定を変更せず、全呼び出しで対象を明示する。
初期構築の操作者には API 有効化、レジストリ/SA/WIF の作成、対象リソースの IAM 追加、
課金予算作成の権限が必要。これらの管理権限をデプロイ用 SA に付けない。

## 作るもの

- Cloud Run、Artifact Registry、IAM、IAM Credentials、STS、Secret Manager、
  Billing Budgets、Cloud Resource Manager の API を有効化する。
- 対象プロジェクト全体を集計する月額 **3,000 JPY** の予算を作る。
  50%・90%・100% の実績通知を課金管理者/課金ユーザーへ送る。
  クレジットで費用が隠れないよう全クレジットを除いて判定する。
  通貨が JPY でなければ作成は失敗する。**予算通知は課金を停止する上限ではない。**
- `asia-northeast1` に Docker リポジトリ `mfmf` を作る。
- `mfmf-runtime` はアプリの実行用。プロジェクト IAM ロールも Secret Manager のアクセスも追加しない。
- `mfmf-deploy` は GitHub の配信用。専用レジストリの writer と、`mfmf-runtime` への actAs だけを付ける。
- WIF の専用 pool `mfmf-github` と provider `github-main` を作り、配信用 SA の短期借用を許可する。
  許可する GitHub は repository ID `1271210275`・owner ID `19723431`、`refs/heads/main`、
  `godhuu0505/mfmf/.github/workflows/deploy-cloud-run.yml@refs/heads/main` の
  `push` / `workflow_dispatch` に限る。PR、別 workflow、同名で再作成されたリポジトリは通らない。

Cloud Build、Cloud SQL、公開サービス、秘密鍵、秘密の値、デプロイ workflow は作らない。
イメージは GitHub でビルドして専用レジストリへ push する想定。
本番の秘密は後続作業で対象 Secret Manager シークレットだけに runtime の read を付ける。

## 再実行と途中失敗

同名リソースがあれば内容を検査して再利用する。予算や WIF の条件が異なる場合、
別 provider が同じ pool にある場合、対象 SA にプロジェクトロールやユーザー管理鍵がある場合は停止する。
WIF は初期条件と、次節の専用スクリプトで有効化する継続配信用の条件だけを厳密一致で認識する。
bootstrap 自体は初期条件を作るだけで、継続配信を有効化したり既存条件を戻したりしない。
既存権限を置き換える `set-iam-policy`、権限削除、鍵作成は行わない。
IAM はリソースごとの `add-iam-policy-binding` だけを使う。

一連の API はトランザクションではない。途中まで作られた予算・リポジトリ・SA は残る。
失敗した理由と既存設定を確認してから再実行する。読み取りが権限不足で失敗した場合は
「リソースが無い」とみなさず停止する。既存 SA の組織/フォルダ継承や他リソースへの
個別付与まで全探索するものではないので、既存アカウントを再利用する場合は管理者が確認する。

## 本番 push からの継続配信を許可する

配信 workflow のレビュー後、管理者が `enable-production-wif.sh` を明示実行する。
既定は外部呼出のない計画表示で、実際の設定照合・更新には `--apply` が必要。

```bash
bash scripts/gcp/enable-production-wif.sh --project PROJECT_ID --project-number PROJECT_NUMBER
# 表示された対象と配信 workflow を確認後、同じ引数へ --apply を追加する。
```

変更するのは既存 `mfmf-github/github-main` provider の **attribute condition だけ**。
repository ID `1271210275`、owner ID `19723431`、`refs/heads/main` を共通必須条件に保ち、
既存の `deploy-cloud-run.yml@refs/heads/main` の push / workflow_dispatch に加え、
`deploy-production.yml@refs/heads/main` の **push だけ**を許可する。
本番 workflow の手動実行、PR、別 ref、別 repository/owner、別 workflow は許可しない。
この変更は workflow にデプロイ処理を追加するものではない。

プロジェクトの数値 ID、pool/provider の名前・有効状態、GitHub issuer、属性 mapping、
空の custom audience を確認する。独自の JWKS/discovery 設定や actor provider、別 provider の
同居も拒否する。condition は旧文字列か新文字列の厳密一致だけを受け入れ、
新条件なら変更なしで終了し、それ以外（空白だけの差異を含む）は上書きしない。
IAM・SA・secret・Cloud Run・予算・課金設定は変更しない。

更新直前に provider を再取得し、他の変更があれば停止する。
CLI に compare-and-swap 用の引数はなく、再取得と更新の間の競合までは防げないため、
実行中は Dashboard / CLI / 他 workflow から同じ provider を編集しない。
更新後は新条件とその他 metadata の不変を照合する。更新試行後に失敗した場合は、
適用結果が未確認のまま自動再試行や rollback をせず、管理者が既存設定を確認する。

一次資料: [OIDC provider の条件更新](https://docs.cloud.google.com/sdk/gcloud/reference/iam/workload-identity-pools/providers/update-oidc)。

## 初回サービス作成後

初回の非公開 Cloud Run サービスは管理者が作成する。実行 SA は `mfmf-runtime`、
リージョンは東京、最小 0 / 最大 1 インスタンスとし、Invoker の IAM 認証を有効にする。
初回だけのために GitHub へプロジェクト全体の Cloud Run 権限を与えない。

```bash
bash scripts/gcp/grant-deploy-access.sh --project PROJECT_ID --service SERVICE_NAME
# 管理者が確認したあと --apply を追加する。
```

このスクリプトは既存サービスの runtime SA と非公開設定を確認してから、
**そのサービスだけ**に配信用 SA の `roles/run.developer` を追加する。
このロールにはサービスの IAM 公開設定変更権限がない。
サービスの新規作成/再作成や一般公開は管理者の作業として残る。

## イメージの保存期間

`configure-artifact-cleanup.sh` は東京の専用 `mfmf` リポジトリにだけ対応する。
プロジェクト数値 ID、名前、形式、bootstrap の説明文を照合し、別の保存ルールがあれば停止する。
既定は外部呼出を行わない計画表示。

```bash
bash scripts/gcp/configure-artifact-cleanup.sh --project PROJECT_ID --project-number PROJECT_NUMBER
# --dry-run を追加: クラウドへシミュレーション設定だけを保存（削除しない）
# 結果を管理者が確認してから --apply: 非dry-runへ切り替える
```

保持ルールは `artifact-cleanup.json`。14 日より古いバージョンを整理し、
**各 package の直近 5 バージョンは日付にかかわらず保護**する。タグ付きも対象になる。
既存の異なる cleanup policy は置き換えない。まず同じポリシーの dry-run 設定が必要。
整理は定期処理で反映され、即時削除コマンドは呼ばない。
古いイメージを再デプロイするための無期限保存にはならないため、ロールバック対象の digest を
確認してから有効化する。14 日以内に大量のイメージを push すれば保存量は増えるので、
**5 バージョンという個数上限や料金上限ではない**。

[dry-run の一次資料](https://docs.cloud.google.com/artifact-registry/docs/repositories/cleanup-policy)に従い、
必要に応じ Artifact Registry の Data Access `DATA_WRITE` 監査ログを確認する。
監査ログの有効化やログ設定の変更はこのスクリプトでは行わない。

## 秘密値の移送前

P1 の配信準備が実行される前に、管理者が対象コンテナと権限だけを用意する。

```bash
bash scripts/gcp/prepare-runtime-secrets.sh --project PROJECT_ID
# 対象確認後に --apply を追加する。
```

対象は `mfmf-token-enc-key` / `mfmf-google-client-id` / `mfmf-google-client-secret` /
`mfmf-sentry-dsn` の4つ。東京の単一レプリカで作成する。既存のレプリカ設定は変更しない。
配信用 SA に対象ごとの `secretVersionAdder`、runtime SA に対象ごとの `secretAccessor` を追加する。
配信用 SA には秘密の読取・削除・IAM 変更権限を与えない。
この段階では秘密値/バージョンの読み書きは一切しない。Sentry の値は任意であり、空の
コンテナが存在しても Cloud Run が存在しないバージョンを参照する設定にはしない。

## 検証

```bash
for gcp_script in scripts/gcp/*.sh; do bash -n "$gcp_script" || exit; done
python3 tests/scripts/gcp-bootstrap.test.py
```

テストは一時フォルダの偽 gcloud だけを実行し、クラウドに接続しない。
計画表示、繰り返し適用、対象取り違え、読取失敗、不一致の既存予算/WIF、
秘密鍵/広い既存権限、公開サービスへの付与拒否を確認する。
継続配信の条件については許可する3組の workflow/event と、PR・手動本番実行・
別 ref/repository/owner の拒否、既存設定の不一致、更新失敗後の再試行禁止も確認する。
条件式のローカル検証は使用する CEL の論理演算・等値・集合判定だけを対象とし、
実際の OIDC token 交換や GCP 上の権限を検証した結果ではない。

一次資料: [WIF とデプロイパイプライン](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines)、
[Cloud Run IAM](https://docs.cloud.google.com/run/docs/reference/iam/roles)、
[予算作成 CLI](https://docs.cloud.google.com/sdk/gcloud/reference/billing/budgets/create)。

## P2 / P3の前段調査

`node scripts/gcp/migration-inventory.mjs` はGit管理下のソースだけを読み、Supabase依存の静的候補をJSONで出す。
クラウド・DB・実envには接続しない。件数は移行完了の判定ではない。
使い方・検出限界・次のStorage境界は [移行前調査](../../docs/guides/gcp-migration-preflight.md) を参照。
