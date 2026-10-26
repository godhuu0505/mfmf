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
既存権限を置き換える `set-iam-policy`、権限削除、鍵作成は行わない。
IAM はリソースごとの `add-iam-policy-binding` だけを使う。

一連の API はトランザクションではない。途中まで作られた予算・リポジトリ・SA は残る。
失敗した理由と既存設定を確認してから再実行する。読み取りが権限不足で失敗した場合は
「リソースが無い」とみなさず停止する。既存 SA の組織/フォルダ継承や他リソースへの
個別付与まで全探索するものではないので、既存アカウントを再利用する場合は管理者が確認する。

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

## 検証

```bash
bash -n scripts/gcp/bootstrap.sh scripts/gcp/grant-deploy-access.sh
python3 tests/scripts/gcp-bootstrap.test.py
```

テストは一時フォルダの偽 gcloud だけを実行し、クラウドに接続しない。
計画表示、繰り返し適用、対象取り違え、読取失敗、不一致の既存予算/WIF、
秘密鍵/広い既存権限、公開サービスへの付与拒否を確認する。

一次資料: [WIF とデプロイパイプライン](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines)、
[Cloud Run IAM](https://docs.cloud.google.com/run/docs/reference/iam/roles)、
[予算作成 CLI](https://docs.cloud.google.com/sdk/gcloud/reference/billing/budgets/create)。
