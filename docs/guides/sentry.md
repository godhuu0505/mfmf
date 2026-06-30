# Sentry でエラーモニタリング / Web Vitals を有効化する

mfmf は `@sentry/nextjs` を **サーバ / Edge ランタイム限定** で組み込み済み。
`SENTRY_DSN` が無いときは SDK が初期化されず通信もしない（no-op）。
本番でエラーモニタリングや Web Vitals 計測を有効化したい時に、本手順で DSN を設定する。

**スコープ**: サーバサイドの例外（Server Component / Server Action / Route
Handler / middleware）が捕捉される。クライアントサイドの React レンダリング
エラーは含めていない（PWA のバンドルサイズを優先）。クライアント側も必要に
なったら `src/instrumentation-client.ts` を作成し `Sentry.init` を呼べば足る。
加えて Web Vitals（LCP/INP/CLS/FCP/TTFB）を Sentry の Trace Metrics として送り、
画面ごとの p75 を継続的に追える（→ [Web Vitals の p75 を確認する](#web-vitals-の-p75-を確認する)）。

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

## Web Vitals の p75 を確認する

主要画面の Web Vitals を Sentry 側で **p75** として継続的に見るための運用手順。
独自ダッシュボードや DB テーブルは持たず、Sentry の Trace Metrics に寄せている。

### 仕組み

- `src/components/WebVitalsReporter.tsx`（全ページ配置）がナビゲーションごとに
  CLS / INP / LCP / FCP / TTFB を取得し、本番は `/api/vitals` へ `sendBeacon`
  （開発時は console に出すだけで送信しない）。送る値は **PII 無し**
  （name / value / rating / id / navigationType / path）。
- `src/app/api/vitals/route.ts` が受け取り、`Sentry.metrics.distribution()` で
  **Trace Metrics** として送出する。distribution 型は分布を保持するので Sentry
  側でパーセンタイル（p75 など）を集計できる。送信後に `Sentry.flush()` で確実に
  送る（serverless 関数が凍結して計測が失われないため）。
- **前提**: `SENTRY_DSN` が設定されていること。未設定なら SDK は no-op で何も送らない。

### メトリクス名と属性

| メトリクス名 | 元の Web Vital | 単位 |
| --- | --- | --- |
| `web_vital.lcp` | LCP | millisecond |
| `web_vital.inp` | INP | millisecond |
| `web_vital.cls` | CLS | none（スコア） |
| `web_vital.fcp` | FCP | millisecond |
| `web_vital.ttfb` | TTFB | millisecond |

各メトリクスには属性（attributes）が付く:

- `metric` — 元の名前（`LCP` など）
- `rating` — `good` / `needs-improvement` / `poor` / `unknown`
- `path` — 計測時の `window.location.pathname`（画面の識別に使う）
- `navigation_type` — `navigate` / `reload` / `back-forward` など

### Sentry 上で見る

1. Sentry プロジェクトの **Metrics**（Trace Explorer / メトリクスのエクスプローラ）を開く。
2. メトリクスに `web_vital.lcp`（や `web_vital.inp` 等）を選ぶ。
3. 集計関数を **p75** にする。
4. **Group by** に `path` を指定すると、画面ごとの p75 が並ぶ。
   `rating` で group by すれば good/poor の内訳も見られる。
5. ダッシュボードに保存しておくと継続的に追える。

主要画面の `path` 例: `/`（一覧）, `/records/new`, `/records/[id]`, `/calendar`,
`/gallery`, `/weight`, `/pets`, `/settings`, `/shares`。

> Trace Metrics は比較的新しい機能のため、組織（org）によっては Sentry 側で
> 有効化（beta のオプトイン）が必要な場合がある。Metrics のメニューが見当たらない
> ときは組織の設定 / プランで Metrics が利用可能か確認する。

## トラブルシュート

| 症状 | 原因 / 対処 |
| --- | --- |
| ローカルで Sentry の警告が出続ける | `SENTRY_DSN` を空に保つ（既定で no-op） |
| Vercel ビルドで source map が出る警告 | `SENTRY_AUTH_TOKEN` を設定する（無ければ upload は自動で disable） |
| クライアントエラーが届かない | `NEXT_PUBLIC_SENTRY_DSN` がブラウザに渡っているか確認（rebuild が必要） |
| Web Vitals の p75 が出ない | `SENTRY_DSN` が本番に設定されているか / 本番ビルドか（開発時は送信しない） / Sentry org で Metrics が有効か確認 |
