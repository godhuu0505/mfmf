# アーキテクチャ・リファレンス

mfmf の構成・画面・データモデルの事実をまとめた参照用ドキュメントです。
設計の「なぜ」は [explanation/design-decisions.md](../explanation/design-decisions.md)、
DB / RLS の正は [`supabase/migrations/`](../../supabase/migrations/) です。

## 技術スタック

| 役割 | 採用 | 料金 |
| --- | --- | --- |
| フロント / 配信 | Next.js 15（App Router）+ React 19 + TypeScript(strict) + Tailwind CSS v4 / Vercel Hobby | ¥0 |
| 認証 + DB + 画像ストレージ | Supabase（Free） | ¥0 |

認証は `@supabase/ssr`（Cookie ベースのセッション）。

## デプロイ構成

| 層 | サービス | 役割 |
| --- | --- | --- |
| フロントエンド（画面・配信） | **Vercel** | Next.js アプリ本体。利用者がアクセスする URL はこちら。 |
| バックエンド（認証・DB・画像） | **Supabase** | Auth / Postgres / Storage。フロントから `@supabase/ssr` で接続。 |

> Supabase は画面そのものをホストしません（Edge Functions は未使用）。
> 利用者が開くのは **Vercel の URL** で、その裏で Supabase の DB / 認証 / Storage が動きます。

## 画面

| パス | 内容 |
| --- | --- |
| `/login` | メール + パスワードでログイン |
| `/` | 記録一覧（日付降順、サムネ + 抜粋、記録元で絞り込み） |
| `/records/new` | 新規作成 |
| `/records/[id]` | 詳細 / `?edit=1` で編集 |
| `/weight` | 体重の推移グラフ |
| `/offline` | オフラインフォールバック（PWA） |

加えて、全画面の右下に「ご意見・不具合」フローティングボタンを常設（`FeedbackWidget`）。

## データモデル

`auth.users`（Supabase 標準）に加えて以下のテーブル。詳細は
`supabase/migrations/0001_init.sql` / `0002_record_metadata.sql` / `0003_feedback.sql` /
`0004_tags.sql`。

| テーブル | 役割 | 主な列 |
| --- | --- | --- |
| `daycare_records` | 日々の記録 | `owner_id`, `record_date`, `source`(daycare/home), `author`, `weight_kg`, `body`, タイムスタンプ |
| `record_photos` | 記録に紐づく写真 | `record_id`, `storage_path` |
| `tags` | 自由タグ（オーナーごとの辞書） | `owner_id`, `name`（オーナー内で一意） |
| `record_tags` | 記録 ↔ タグ の多対多 | `record_id`, `tag_id`, `owner_id` |
| `feedback` | ご意見・不具合フォームの送信内容 | `owner_id`, `kind`, `body`, 任意項目, `context`(自動収集), `github_issue_url` ほか |

## 認可・RLS・Storage

- RLS はすべて `owner_id = auth.uid()` ベース（**セキュリティの一次防衛線**）。
- Storage バケット `daycare-photos` は **private**。配信は署名付き URL（期限 1 時間）。
- オブジェクトパス規約: `{owner_id}/{record_id}/{filename}`（生成 / 検証は `src/lib/storagePath.ts`）。
- 写真はクライアントから Storage へ直接アップロードし、Server Action にはパスだけを渡す
  （Vercel Function ボディ上限 4.5MB を超えないため）。

## ソースの地図

| 場所 | 役割 |
| --- | --- |
| `src/app/` | App Router のページ・Server Action（`records/actions.ts` ほか） |
| `src/components/` | クライアントコンポーネント（`RecordForm`, `FeedbackWidget` ほか） |
| `src/lib/supabase/` | Supabase クライアント（`client` / `server` / `middleware`） |
| `src/lib/` | 画像リサイズ・パス生成・写真取得などのユーティリティ |
| `src/types/database.ts` | DB 型定義 |
| `supabase/migrations/` | スキーマ・RLS・Storage ポリシー（連番 SQL） |
| `public/sw.js` | Service Worker（PWA） |
| `scripts/` | アイコン生成・フィードバック Issue 化 |
