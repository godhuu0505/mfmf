# Cloud Run への配信移行

最初に配信だけを検証し、DB・認証・写真は Supabase の認可を維持する。
`Dockerfile.cloudrun` は本番用、従来の `Dockerfile` はローカル開発用。
本番の入口を変更する前に下の確認を完了する。
実公開値での候補イメージ作成と Secret Manager への設定移送は
[候補イメージの準備](./cloud-run-candidate.md)を参照。

## コンテナの検証

```bash
# 公開のローカル検証用 fixture。実配信は専用 Secret Manager key を使う。
NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=BgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgY= \
docker build --platform linux/amd64 -f Dockerfile.cloudrun \
  --build-arg NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder-anon-key \
  --build-arg NEXT_SERVER_ACTIONS_KEY_VERSION=local-smoke-v1 \
  --secret id=next-server-actions-key,env=NEXT_SERVER_ACTIONS_ENCRYPTION_KEY \
  -t mfmf-cloudrun:smoke .
docker run --rm -p 127.0.0.1:8080:8080 mfmf-cloudrun:smoke
# 別ターミナルで、ログイン画面・認証リダイレクト・静的ファイル・PWA を確認
node tests/scripts/cloudrun-smoke.mjs
```

この値は疎通検証用。**本番イメージは実際の公開 Supabase URL / anon key をビルド時に渡す**。
`NEXT_PUBLIC_*` はブラウザコードに埋め込まれるため、Cloud Run の実行時変数だけを変更しても
接続先は変わらない。`service_role` や Google の秘密鍵を build arg に渡してはいけない。
CI は本番資格情報を使わず、実際の Linux コンテナを非 root で起動して検証する。
実配信の Server Actions 専用鍵は BuildKit secret の一時環境変数だけで渡し、build arg にしない。
Next.js が実行に使う private server manifest には専用鍵が含まれるため、実イメージと build cache は
private に保つ。client assets / prerendered HTML・RSC への混入は build 時に検査する。
smoke では外部 Host / HTTPS 転送ヘッダーと内部 bind address が違う条件でも、
OAuth の取消・ログアウト・招待誘導が同一サイトへ戻り、招待 Cookie の更新が
同一 origin に限られることを確認する。

認証 Route Handler の Location は相対パスを使い、Host / Forwarded から公開 origin を推測しない。
middleware は Next.js adapter が要求する絶対URLを内部で保ち、配信時の同origin相対化を使う。
`/auth/next` の POST はブラウザが生成する `Sec-Fetch-Site: same-origin` のみを許可する。
このヘッダーがない場合は、Origin が存在して request URL の origin と完全一致するときだけ許可する。
Fetch Metadata がないクライアントから内部URLの standalone へ送る POST は安全側に拒否される。
この判定を外部 OAuth から到達する callback GET へ適用しない。

Docker に送るファイルは `Dockerfile.cloudrun.dockerignore` の許可リストで限定する。
実 env、ローカルログイン状態、バックアップ、Git 履歴は送らない。
実行イメージには standalone サーバーと静的ファイルのみをコピーする。

## 初期環境の制約

- 東京 `asia-northeast1`。リクエスト課金、最小 0、最大 1 インスタンス、1 vCPU / 512 MiB を初期値とする。
- 検証中のサービスは IAM 認証を必須にし、一般公開・本番入口の切り替えは実ログイン検証後。
- 実行用サービスアカウントとデプロイ用を分離する。実行用は必要な Secret Manager の
  **対象シークレットだけ**読めるようにする。プロジェクトの Editor 権限やサービスアカウント鍵は使わない。
- GitHub からは Workload Identity Federation を使い、リポジトリの数値 ID と
  main のデプロイ経路に信頼を限定する。PR のコードに本番権限を与えない。
- LB、Cloud NAT、常駐 VPC コネクター、常駐検証用 DB は初期構成に追加しない。
- 月 3,000 円の予算通知を 50% / 90% / 100% に設定する。**予算通知は課金の停止上限ではない**。
  Cloud Run の最大インスタンス数だけでも転送量・ストレージ費用は制限できないため、使用量も確認する。

## 本番切り替えの確認項目

1. Supabase が稼働し、暗号化バックアップを復号できることを確認する。
2. サーバー専用の既存設定（暗号鍵、OAuth、監視など）を Secret Manager に安全に移す。
   値をチャット・CI ログ・PR・イメージに出さない。秘密の欠落をプレースホルダで埋めない。
3. 実公開設定でビルドし、候補リビジョンで Google / email ログイン、招待、閲覧、作成、
   編集、写真アップロード、世帯切り替えと viewer/guest の制限を確認する。
4. Supabase の許可するリダイレクト URL とアプリの公開 origin を一致させる。
   `mfmf-1223.vercel.app` は Vercel のドメインなので GCP に DNS 移管できない。
   `run.app` または管理可能な独自ドメインを使う場合は、Cookie と PWA が別 origin になるため
   再ログイン・PWA 再追加が必要になることを利用者へ案内する。
5. 初回アクセスの待ち時間とメモリを実測する。最小インスタンスを増やす前に月額を再計算する。
6. 公開先を切り替え、旧 Vercel URL をロールバック期間中は保つ。
   この段階の DB / Auth / Storage は同一なので、戻す際のデータコピーは不要。

DB・Storage・認証の移行では別途、世帯/RLS・署名 URL・UID の引継ぎと復元の検証が必要。
**配信の移行成功だけをもって Supabase を停止しない**。

参考: [Next.js standalone](https://nextjs.org/docs/15/app/api-reference/config/next-config-js/output)、
[Cloud Run のコンテナ要件](https://docs.cloud.google.com/run/docs/container-contract)、
[予算とアラート](https://docs.cloud.google.com/billing/docs/how-to/budgets)。
