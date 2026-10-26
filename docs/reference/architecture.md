# アーキテクチャ・リファレンス

構成の**地図**です。**現状の仕様（画面一覧・データモデル・RLS）はここには書きません** ——
コードから復元できるものは腐るため（[decisions.md D16](../explanation/decisions.md)）。
それらを知りたいときは下表の「正」を読むか、AI にコードを読ませてください。

| 知りたいこと | 正 |
| --- | --- |
| 画面の一覧・ルーティング | [`src/app/`](../../src/app/)（ディレクトリがそのままパス） |
| テーブル・列・RLS・Storage ポリシー | [`supabase/migrations/`](../../supabase/migrations/)（連番 SQL） |
| DB の型 | [`src/types/database.ts`](../../src/types/database.ts) |
| 認可ヘルパーの使い分け | [`CLAUDE.md`](../../CLAUDE.md) セキュリティ節 ／ [`src/lib/household.ts`](../../src/lib/household.ts) |
| 写真・アバターの認可と保存先 | [`src/lib/mediaAuthorization.ts`](../../src/lib/mediaAuthorization.ts) ／ [`src/lib/mediaStorage.ts`](../../src/lib/mediaStorage.ts) ／ [画像台帳の契約](./media-storage-ledger.md) |
| ユーザー視点の機能一覧 | アプリ内 `/help`（[`src/app/(app)/help/page.tsx`](../../src/app/(app)/help/page.tsx)） |
| 設計の「なぜ」・却下した案 | [explanation/decisions.md](../explanation/decisions.md) |

## 技術スタック

| 役割 | 採用 | 料金 |
| --- | --- | --- |
| フロント / 配信 | Next.js 15（App Router）+ React 19 + TypeScript(strict) + Tailwind CSS v4 / Cloud Run | 従量課金・min 0 / max 1 |
| 認証 + DB | Supabase（Free） | 無料枠内 |
| 写真・アバター | Cloud Storage / 東京 | 従量課金 |

GCPの月3,000円予算通知は支出の強制上限ではない。移行手順・費用の前提は
[GCP移行計画](../explanation/gcp-migration.md)を参照。

認証は `@supabase/ssr`（Cookie ベースのセッション）。バージョンの正は
[`package.json`](../../package.json)。

## デプロイ構成

| 層 | サービス | 役割 |
| --- | --- | --- |
| フロントエンド（画面・配信） | **Cloud Run** | Next.jsアプリと、鍵ファイルを使わないGCS署名・画像検証。 |
| 認証・DB | **Supabase** | Auth / Postgres / RLS。`@supabase/ssr` で利用者のセッションを渡す。 |
| 写真・アバター | **Cloud Storage** | 非公開の2バケット。対象行で認可した後に世代固定の読取URLを発行する。 |
| 旧入口 | **Vercel** | GCS読取への切替後は固定Cloud Run URLへ誘導。切替前とローカルではSupabase Storageを使用する。 |

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
| `src/lib/supabase/` | Supabase クライアント（`client` / `server` / `middleware`） |
| `src/lib/household.ts` | 世帯の解決と認可ヘルパー |
| `src/lib/` | 画像リサイズ・パス生成・写真取得などのユーティリティ |
| `src/types/database.ts` | DB 型定義 |
| `supabase/migrations/` | スキーマ・RLS・Storage ポリシー（連番 SQL） |
| `supabase/tests/` | pgTAP。テナント分離を CI で守っている |
| `public/sw.js` | Service Worker（PWA） |
| `scripts/` | アイコン生成・フィードバック Issue 化 |
