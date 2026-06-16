# Supabase バックエンドとデプロイ済みアプリの確認

mfmf の構成と、**デプロイされたアプリ／Supabase バックエンドが正しく動いているかの確認手順**をまとめます。

## 構成（どこに何がデプロイされるか）

mfmf は 2 つのサービスに分かれてデプロイされます。

| 層 | サービス | 役割 |
| --- | --- | --- |
| フロントエンド（画面・配信） | **Vercel** | Next.js（App Router）アプリ本体。ユーザーがアクセスする URL はこちら。 |
| バックエンド（認証・DB・画像） | **Supabase** | Auth / Postgres / Storage。フロントから `@supabase/ssr` で接続。 |

> Supabase はアプリの「画面」そのものをホストしません（Edge Functions は使っていません）。
> 利用者が開くのは **Vercel の URL** で、その裏で Supabase の DB / 認証 / Storage が動く、という関係です。
> 「Supabase でデプロイされたアプリ」= Supabase をバックエンドに持つこのアプリ、という意味になります。

---

## 1. デプロイ済みフロントエンド（Vercel）を開く

1. [Vercel ダッシュボード](https://vercel.com/dashboard) で mfmf プロジェクトを開く。
2. **Production** の URL（`https://<project>.vercel.app` など）を開く。
3. `/login` でログインし、一覧 → 新規作成 → 写真添付 → 詳細表示まで一通り動けば正常。
4. ログインできない場合は、Vercel の **Settings > Environment Variables** に
   `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` が
   正しい Supabase プロジェクトの値で設定されているか確認する。

---

## 2. Supabase バックエンドの確認

[Supabase ダッシュボード](https://supabase.com/dashboard) で対象プロジェクト（`mfmf`）を開いて確認します。

### 2-1. プロジェクトが稼働中か

- トップで **Status が ACTIVE / Healthy** であること。
- 一定期間アクセスが無いと Free プランは一時停止することがある。その場合は **Restore / Resume** で復帰。

### 2-2. テーブルとデータ

**Table Editor** で以下を確認。

- `public.daycare_records` … 記録本体（`owner_id`, `record_date`, `body`, タイムスタンプ）
- `public.record_photos` … 写真メタデータ（`record_id`, `storage_path`）

両テーブルとも **RLS（Row Level Security）が有効**であること（テーブル名の横に "RLS enabled" 表示）。

### 2-3. 認証ユーザー

**Authentication > Users** に、ログインに使うユーザー（夫婦で最大 2 人）が存在すること。
サインアップ UI は無いため、ここから手動で発行する。

### 2-4. Storage

**Storage** に `daycare-photos` バケットがあり、**private（公開オフ）**であること。
画像は署名付き URL（期限 1 時間）で配信される。
オブジェクトパス規約: `{owner_id}/{record_id}/{filename}`。

### 2-5. マイグレーション

**Database > Migrations** に `0001_init`（テーブル / RLS / Storage / トリガ）が適用されていること。
未適用なら `supabase/migrations/0001_init.sql` を **SQL Editor** で実行する。

### 2-6. セキュリティ / パフォーマンス advisor

**Advisors** タブで、RLS 未設定や危険な公開設定などの警告が出ていないこと（0 件が望ましい）。
DDL 変更後はここを必ず確認する。

---

## 3. 接続のスモークテスト

「フロントが正しい Supabase に繋がっているか」を最短で確認する方法。

1. デプロイ済みアプリ（または `npm run dev`）でログインする。
2. 記録を 1 件作成し、写真を 1 枚添付する。
3. Supabase ダッシュボードの **Table Editor** で `daycare_records` / `record_photos` に行が増え、
   **Storage** の `daycare-photos` に画像が保存されていれば、フロント ↔ バックエンドの接続は正常。

ローカルから直接確認したい場合は、ブラウザのコンソールではなく、
Supabase ダッシュボード側にデータが反映されるかで判断するのが確実（RLS により他人のデータは見えないため）。

---

## 4. 環境変数の対応表

| 変数 | 取得元（Supabase） | 使う場所 |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Project Settings > API > Project URL | ローカル `.env.local` / Vercel 環境変数 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Project Settings > API > anon / publishable key | ローカル `.env.local` / Vercel 環境変数 |

> `service_role` キーはサーバー専用の特権鍵。本アプリでは使わず、`NEXT_PUBLIC_` でも公開しないこと。

ローカル環境の作り方は [docs/local-setup.md](./local-setup.md) を参照。
