# Sentry でエラーモニタリングを有効化する

mfmf は `@sentry/nextjs` を **サーバ / Edge ランタイム限定** で組み込み済み。
`SENTRY_DSN` が無いときは SDK が初期化されず通信もしない（no-op）。
本番でエラーモニタリングを有効化したい時に、本手順で DSN を設定する。

**スコープ**: サーバサイドの例外（Server Component / Server Action / Route
Handler / middleware）が捕捉される。クライアントサイドの React レンダリング
エラーは含めていない（PWA のバンドルサイズを優先）。クライアント側も必要に
なったら `src/instrumentation-client.ts` を作成し `Sentry.init` を呼べば足る。

## 1. Sentry プロジェクトを用意する

1. [sentry.io](https://sentry.io/) でアカウントを作成（Developer プランで開始可、~5k errors/月まで無料）
2. New Project から **Next.js** を選択し、プロジェクト名を `mfmf` などで作成
3. DSN（`https://...@oXXXXX.ingest.sentry.io/YYYY` のような URL）が発行されるので控える

## 2. 環境変数を設定する

`.env.local` または Vercel のプロジェクト設定で以下を設定する。

```
SENTRY_DSN=https://...@oXXXXX.ingest.sentry.io/YYYY
```

任意で sampling rate を絞れる（既定 `0.1` = 10%）:

```
SENTRY_TRACES_SAMPLE_RATE=0.05
```

クライアント側も有効化する場合は `src/instrumentation-client.ts` を追加し、
`NEXT_PUBLIC_SENTRY_DSN` を設定する（バンドルサイズが ~80 KB 増えるので
本当に必要になってから入れることを推奨）。

## 3. Source map のアップロード（任意）

スタックトレースを元のソースで見られるようにするには Sentry CLI に渡す
auth token が必要。CI/CD（Vercel）に以下を追加する:

```
SENTRY_ORG=your-org-slug
SENTRY_PROJECT=mfmf
SENTRY_AUTH_TOKEN=sntrys_xxxxxxxxxxxx
```

これらが揃ったときだけ `next.config.mjs` の `withSentryConfig` が
ビルド時に source map をアップロードする（未設定なら upload は無効）。
auth token は Sentry の Settings → Auth Tokens から、`project:releases`
スコープで発行する。

## 4. 動作確認

- ローカル: `npm run build && npm start` → ブラウザでエラーを発生させ Sentry の Issues に届くか確認
- 本番: 開発者ツールから `Sentry.captureException(new Error("test"))` を呼ぶ

## 仕組み（参考）

- `src/instrumentation.ts` — Node / Edge ランタイムでの `Sentry.init` + `onRequestError`
- `next.config.mjs` — `withSentryConfig` で build-time プラグインを有効化
- クライアント側 SDK は同梱しない（バンドルサイズ優先）。導入する場合は
  `src/instrumentation-client.ts` を追加して `Sentry.init({ dsn: process.env.NEXT_PUBLIC_SENTRY_DSN, ... })` を呼ぶ
- Session Replay は **意図的に無効**（写真記録という性質上、画面録画を保持したくない）

## トラブルシュート

| 症状 | 原因 / 対処 |
| --- | --- |
| ローカルで Sentry の警告が出続ける | `SENTRY_DSN` を空に保つ（既定で no-op） |
| Vercel ビルドで source map が出る警告 | `SENTRY_AUTH_TOKEN` を設定する（無ければ upload は自動で disable） |
| クライアントエラーが届かない | `NEXT_PUBLIC_SENTRY_DSN` がブラウザに渡っているか確認（rebuild が必要） |
