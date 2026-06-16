# mfmf

ペット保育園記録アプリ（フェーズ1）

保育園からの日々の記録（テキスト＋写真）を残し、夫婦で振り返るためのミニマムな Web アプリです。

## 技術スタック

| 役割 | 採用 | 料金 |
| --- | --- | --- |
| フロント / 配信 | Next.js（App Router）+ TypeScript + Tailwind CSS v4 / Vercel Hobby | ¥0 |
| 認証 + DB + 画像ストレージ | Supabase（Free） | ¥0 |

認証は `@supabase/ssr`（Cookie ベースのセッション）。

## フェーズ1のスコープ

- **① ログイン**: email / password（Supabase Auth）。サインアップ UI は無し（アカウントはダッシュボードで手動発行）。
- **② テキストの保管・表示**: 記録の CRUD（日付＋本文）、一覧 / 詳細 / 編集 / 削除。
- **③ 画像の紐付け**: 1記録に複数枚アップロード → Storage 保存 → テキストと並べて表示、一覧にサムネ。

意図的に外すもの: LINE 自動取り込み / カレンダー連携 / Google ドライブ・フォト連携 / プッシュ通知 / ネイティブアプリ。

### UX 改善（フェーズ1.5）

- **PWA 化**: `manifest.webmanifest`（Next.js metadata route）+ Service Worker（`public/sw.js`）でホーム画面に追加でき、スタンドアロン表示・オフラインフォールバック（`/offline`）に対応。
  - Service Worker は本番ビルドでのみ登録。静的アセットは stale-while-revalidate、ページ遷移は network-first。**Supabase の API レスポンスや署名付き写真 URL（private / 期限付き）はキャッシュしない**。
  - アイコンは `npm run icons`（`scripts/generate-icons.mjs`）で生成。外部の画像ライブラリに依存せず、Node 標準の zlib で肉球モチーフの PNG を直接エンコードする。
- **画像のアップロード時リサイズ・圧縮**: 選択された画像をブラウザ側で長辺 1600px に縮小し JPEG 再圧縮（`src/lib/imageResize.ts`）してから Storage へ送る。EXIF の向きも反映。Storage 使用量と通信量を抑える。

### 共有方針: (A) 1アカウント共用

夫婦で同じログインを共用する前提。`household_id` は持たず、`owner_id (= auth.uid())` ベースで RLS を設定。
将来 (B) 世帯共有へ移行する場合は `household_id` 列を追加して移行する。

## データモデル

`auth.users`（Supabase 標準）に加えて以下2テーブル。詳細は `supabase/migrations/0001_init.sql`。

- `daycare_records` — 保育園からの記録（`owner_id`, `record_date`, `body`, タイムスタンプ）
- `record_photos` — 記録に紐づく写真（`record_id`, `storage_path`）

RLS は `owner_id` ベース。Storage バケット `daycare-photos` は private、署名付き URL で配信。
オブジェクトパス規約: `{owner_id}/{record_id}/{filename}`。

## 画面

1. `/login` — メール + パスワード
2. `/` — 記録一覧（日付降順、サムネ + 抜粋）
3. `/records/new` — 新規作成
4. `/records/[id]` — 詳細 / `?edit=1` で編集

## セットアップ

### 1. 依存インストール

```bash
npm install
```

### 2. Supabase

1. Supabase プロジェクトを用意する。
2. `supabase/migrations/0001_init.sql` を SQL Editor で実行（テーブル / RLS / Storage バケット）。
3. ユーザーを Authentication > Users から手動発行する（夫婦の最大2人）。

### 3. 環境変数

`.env.local.example` を `.env.local` にコピーし、Supabase の URL と anon key を設定。

```bash
cp .env.local.example .env.local
```

### 4. 開発サーバー

```bash
npm run dev
```

http://localhost:3000 を開く。

## デプロイ（Vercel）

1. リポジトリを Vercel に接続。
2. 環境変数 `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` を設定。
3. デプロイ。
