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
- **④ 記録メタデータ**: 記録元（🏫 保育園 / 🏠 おうち）・記入者・体重(kg)を任意で残せる。保育園とおうち（両親）どちらのノートも同じ仕組みで登録でき、一覧は記録元で絞り込み、詳細・一覧に記録元バッジと体重を表示して後から振り返れる。
- **⑤ ご意見・不具合フォーム**: どの画面でも右下に出るフローティングボタンから、障害報告・機能要望を送れる。必須は内容のみで、任意項目（種類・困り度・頻度・期待/実際の動きなど）で詳しく聞ける。送信時に開いていた画面・端末情報などのアプリの状況を自動で添付。内容は **Supabase の `feedback` テーブル（非公開・RLS 保護）にのみ保存** し、アプリからは GitHub に何も送らない。GitHub Issue 化が必要なときは、`npm run feedback:issues`（`scripts/feedback-to-issues.mjs`）で個人情報・秘匿情報をマスクし、**非公開リポジトリ宛て**に転記する（`src/components/FeedbackWidget.tsx` / `src/app/feedback/actions.ts`）。

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

`auth.users`（Supabase 標準）に加えて以下3テーブル。詳細は `supabase/migrations/0001_init.sql`・`0002_record_metadata.sql`・`0003_feedback.sql`。
検索高速化のインデックスは `0004_record_search.sql`（`pg_trgm` による本文・記入者の部分一致 + 体重の並び替え）で追加する。

- `daycare_records` — 日々の記録（`owner_id`, `record_date`, `source`=daycare/home, `author`, `weight_kg`, `body`, タイムスタンプ）
- `record_photos` — 記録に紐づく写真（`record_id`, `storage_path`）
- `feedback` — ご意見・不具合フォームの送信内容（`owner_id`, `kind`, `body`, 任意項目, `context`=自動収集したアプリの状況, `github_issue_url` ほか）

RLS は `owner_id` ベース。Storage バケット `daycare-photos` は private、署名付き URL で配信。
オブジェクトパス規約: `{owner_id}/{record_id}/{filename}`。

## 画面

1. `/login` — メール + パスワード
2. `/` — 記録一覧（サムネ + 抜粋）。本文・記入者のキーワード検索、記録元・期間での絞り込み、日付/体重での並び替え、ページネーションに対応。条件は URL クエリ（`?q=&from=&to=&source=&sort=&page=`）に同期され、共有・リロードで再現できる。
3. `/records/new` — 新規作成
4. `/records/[id]` — 詳細 / `?edit=1` で編集

加えて、全画面の右下に「ご意見・不具合」フローティングボタンを常設（`FeedbackWidget`）。

## ローカル環境構築（クイックスタート）

最短の手順は以下。詳細・トラブルシュートや Supabase CLI を使うローカルスタック構成は
**[docs/local-setup.md](./docs/local-setup.md)** を参照してください。

```bash
# 1. 依存インストール
npm install

# 2. 環境変数を用意し、Supabase の URL / anon key を設定
cp .env.local.example .env.local
#   NEXT_PUBLIC_SUPABASE_URL=https://<PROJECT_REF>.supabase.co
#   NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon または publishable key>

# 3. 開発サーバー
npm run dev   # http://localhost:3000
```

Supabase 側の準備（初回のみ）:

1. Supabase プロジェクトを用意する。
2. `supabase/migrations/` の SQL を連番順に SQL Editor で実行（`0001_init.sql`=テーブル / RLS / Storage バケット、`0002_record_metadata.sql`=記録元・記入者・体重の列追加、`0003_feedback.sql`=ご意見・不具合フォームの保存テーブル / RLS、`0004_record_search.sql`=検索高速化インデックス（`pg_trgm`）の追加）。
3. ユーザーを Authentication > Users から手動発行する（サインアップ UI は無し）。共有方針は (A) 1アカウント共用のため、**夫婦で共有する 1 つのログイン**を発行して 2 人で使う（RLS が `owner_id` ベースのため、ユーザーを分けると記録が共有されない）。

接続情報（URL / anon key）は Supabase ダッシュボード > **Project Settings > API** から取得します。

### npm スクリプト

```bash
npm run dev        # 開発サーバー
npm run build      # 本番ビルド
npm run start      # 本番ビルドの起動
npm run lint       # ESLint
npm run typecheck  # tsc --noEmit
npm run icons      # PWA アイコン再生成
npm run feedback:issues  # フィードバックをマスクして非公開リポに Issue 化
```

### ご意見・不具合フォームの Issue 化（運用）

公開リポジトリに内容が漏れないよう、アプリは GitHub に何も送らず、送信内容は Supabase の
`feedback` テーブルにのみ保存します。GitHub Issue 化が必要になったら、個人情報・秘匿情報を
マスクしたうえで **非公開(private)リポジトリ宛て** に転記するスクリプトを手元で実行します。

```bash
# 1. .env.local に以下を設定（.env.local.example 参照）
#    FEEDBACK_USER_EMAIL / FEEDBACK_USER_PASSWORD … 夫婦共用ログイン（RLS 経由で取得）
#    GITHUB_TOKEN … Issues 書き込み権の Fine-grained PAT
#    GITHUB_FEEDBACK_REPO … 登録先 owner/repo（★ 必ず非公開リポジトリ）

# 2. まずマスク結果を目視確認（GitHub には登録しない）
node --env-file=.env.local scripts/feedback-to-issues.mjs --dry-run

# 3. 問題なければ登録（登録済みは github_issue_number で重複登録を防止）
node --env-file=.env.local scripts/feedback-to-issues.mjs
```

メール・電話番号・トークン/API キー・URL のクエリ等は自動でマスクしますが、名前など一般語は
自動検出できないため、`--dry-run` で必ず内容を確認してから登録してください。

## デプロイと確認

mfmf は **フロントエンドを Vercel、バックエンド（認証 / DB / 画像）を Supabase** に分けてデプロイします。
デプロイ済みアプリや Supabase バックエンドの **確認手順**は
**[docs/supabase.md](./docs/supabase.md)** にまとめています。

### デプロイ（Vercel / CI・CD）

デプロイは **GitHub Actions から Vercel CLI で明示的に**行う（Vercel の Git 連携自動デプロイは
`vercel.json` の `git.deploymentEnabled: false` で無効化）。

| トリガ | デプロイ先 | ワークフロー |
| --- | --- | --- |
| PR | （CI のみ：lint / typecheck / build） | `ci.yml` |
| main へマージ(push) | Vercel **Preview** | `deploy-preview.yml` |
| タグ付き Release 公開 | Vercel **Production** | `deploy-production.yml` |

- main はマージしても **Preview 止まり**。**本番反映はタグ付き Release の公開がトリガ**。
- どちらも CI（`ci.yml` を再利用）が緑のときだけデプロイされる。
- ご意見・不具合フォームの内容は Supabase に保存されるだけで、デプロイ環境に GitHub 関連の環境変数は不要（アプリは GitHub に送らない）。Issue 化は下記スクリプトを手元で実行する。

初回セットアップ（`VERCEL_TOKEN` / `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID` の登録）と本番リリース手順は
**[docs/deploy.md](./docs/deploy.md)** を参照。

## ドキュメント

- [docs/local-setup.md](./docs/local-setup.md) — ローカル環境構築（リモート Supabase / ローカルスタックの両対応・トラブルシュート）
- [docs/supabase.md](./docs/supabase.md) — Supabase バックエンド構成とデプロイ済みアプリの確認手順
- [docs/deploy.md](./docs/deploy.md) — デプロイ / CI・CD（main→Preview、Release→Production）と初回セットアップ
