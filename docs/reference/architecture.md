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
| ユーザー視点の機能一覧 | アプリ内 `/help`（[`src/app/help/page.tsx`](../../src/app/help/page.tsx)） |
| 設計の「なぜ」・却下した案 | [explanation/decisions.md](../explanation/decisions.md) |

## 技術スタック

| 役割 | 採用 | 料金 |
| --- | --- | --- |
| フロント / 配信 | Next.js 15（App Router）+ React 19 + TypeScript(strict) + Tailwind CSS v4 / Vercel Hobby | ¥0 |
| 認証 + DB + 画像ストレージ | Supabase（Free） | ¥0 |

認証は `@supabase/ssr`（Cookie ベースのセッション）。バージョンの正は
[`package.json`](../../package.json)。

## デプロイ構成

| 層 | サービス | 役割 |
| --- | --- | --- |
| フロントエンド（画面・配信） | **Vercel** | Next.js アプリ本体。利用者がアクセスする URL はこちら。 |
| バックエンド（認証・DB・画像） | **Supabase** | Auth / Postgres / Storage。フロントから `@supabase/ssr` で接続。 |

> Supabase は画面そのものをホストしません（Edge Functions は未使用）。
> 利用者が開くのは **Vercel の URL** で、その裏で Supabase の DB / 認証 / Storage が動きます。

手順は [guides/deploy.md](../guides/deploy.md)、方針の背景は
[decisions.md D22](../explanation/decisions.md)。

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
