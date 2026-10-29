# アーキテクチャ・リファレンス

構成の**地図**です。**現状の仕様（画面一覧・データモデル・RLS）はここには書きません** ——
コードから復元できるものは腐るため（[decisions.md D16](../explanation/decisions.md)）。
それらを知りたいときは下表の「正」を読むか、AI にコードを読ませてください。

| 知りたいこと | 正 |
| --- | --- |
| 画面の一覧・ルーティング | [`src/app/`](../../src/app/)（ディレクトリがそのままパス） |
| 本番DBのbaseline・追加migration・RLS | [`db/gcp/`](../../db/gcp/) ／ [適用・検証契約](../../db/gcp/README.md) |
| Supabase互換元・ローカルDB・Storageポリシー | [`supabase/migrations/`](../../supabase/migrations/)（連番SQL、GCPのsource manifestで追跡） |
| DB の型 | [`src/types/database.ts`](../../src/types/database.ts) |
| 認可ヘルパーの使い分け | [`CLAUDE.md`](../../CLAUDE.md) セキュリティ節 ／ [`src/lib/household.ts`](../../src/lib/household.ts) |
| 写真・アバターの認可と保存先 | [`src/lib/mediaAuthorization.ts`](../../src/lib/mediaAuthorization.ts) ／ [`src/lib/mediaStorage.ts`](../../src/lib/mediaStorage.ts) ／ [画像台帳の契約](./media-storage-ledger.md) |
| ユーザー視点の機能一覧 | アプリ内 `/help`（[`src/app/(app)/help/page.tsx`](../../src/app/(app)/help/page.tsx)） |
| 設計の「なぜ」・却下した案 | [explanation/decisions.md](../explanation/decisions.md) |

## 技術スタック

| 役割 | 採用 | 料金 |
| --- | --- | --- |
| フロント / 配信 | Next.js 15（App Router）+ React 19 + TypeScript(strict) + Tailwind CSS v4 / Cloud Run | 従量課金・min 0 / max 1 |
| 認証 | Identity Platform（Google / email） | MAU等に応じた従量課金・無料枠あり |
| DB | Cloud SQL PostgreSQL 17 / Enterprise / db-f1-micro / 東京単一ゾーン | 従量課金、共有コアはSLA対象外・本番非推奨 |
| 写真・アバター | Cloud Storage / 東京 | 従量課金 |

GCPの月3,000円予算通知は支出の強制上限ではない。移行手順・費用の前提は
[GCP移行計画](../explanation/gcp-migration.md)を参照。

本番はhost単位のHttpOnly CookieとIdentity Platformの検証・失効確認を使う。
`@supabase/ssr` はSupabaseモード用に残す。バージョンは [`package.json`](../../package.json)、
DB補助バイナリの固定版は [`Dockerfile.cloudrun`](../../Dockerfile.cloudrun) を正とする。

## デプロイ構成

| 層 | サービス | 役割 |
| --- | --- | --- |
| アプリ | **Cloud Run** | 単一containerでNext.js・loopback PostgREST・Cloud SQL Auth Proxy。1CPU/1GiB、concurrency2、min0/max1、DB pool2。 |
| 認証 | **Identity Platform** | 署名・project・失効を検証したidentityを内部UUIDへ対応付ける。ブラウザからDBへ直結しない。 |
| DB | **Cloud SQL** | Private IPのみ、connector必須。Direct VPCのprivate-ranges-onlyで接続し、既存の世帯/ゲストRLSを維持。 |
| 写真・アバター | **Cloud Storage** | 非公開の2バケット。対象行で認可した後に世代固定の読取URLを発行する。 |
| 旧入口・保全元 | **Vercel / Supabase** | 旧URLは固定Cloud Run URLへ誘導。元DBのpublicとcredential Auth書込は凍結保全し、通常配信から更新しない。 |

切替状態はDBの `media_storage_state` が管理する。書込の凍結中も直前の保存先で画像を読める。
GCS切替後にSupabaseの旧画像へ自動で戻さない。Cloud Runへ移る際はCookieとPWAが
originをまたいで引き継がれないため、再ログイン・再登録が必要になる。

手順は [guides/deploy.md](../guides/deploy.md)、方針の背景は
[decisions.md D38 / D40](../explanation/decisions.md)。

## ソースの地図

| 場所 | 役割 |
| --- | --- |
| `src/app/` | App Router のページ・Server Action（`records/actions.ts` ほか） |
| `src/components/` | クライアントコンポーネント（`RecordForm`, `FeedbackWidget` ほか） |
| `src/lib/supabase/` | 共通入口。server/middlewareはモードで分岐し、browser clientはSupabaseモード専用 |
| `src/lib/identity/` | Identity Platform認証、Cookie、失効、CSRFの境界 |
| `src/lib/gcp/dataClient.ts` | supabase-jsクエリビルダを使うserver専用loopback PostgREST bridge |
| `scripts/gcp/runtime.mjs` | Next.js・PostgREST・Auth Proxyの起動と監視 |
| `src/lib/household.ts` | 世帯の解決と認可ヘルパー |
| `src/lib/` | 画像リサイズ・パス生成・写真取得などのユーティリティ |
| `src/types/database.ts` | DB 型定義 |
| `db/gcp/` / `tests/gcp/` | 本番baseline・operator・追加SQLの契約と隔離DB/復元/実PostgREST試験 |
| `supabase/migrations/` | 元スキーマ・RLS・ローカルStorageポリシー（連番SQL） |
| `supabase/tests/` | pgTAP。テナント分離を CI で守っている |
| `public/sw.js` | Service Worker（PWA） |
| `scripts/` | アイコン生成・フィードバック Issue 化 |
