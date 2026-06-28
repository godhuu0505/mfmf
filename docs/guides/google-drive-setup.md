# Google ログイン / Drive 連携のセットアップ

mfmf は **Google ログイン**で認証し、写真を各自の **Google Drive** に保存します。
この手順書は、その動作に必要な Google Cloud と Supabase の設定をまとめたものです。
コード側（ログイン画面・コールバック・トークン保存）は実装済みで、ここでの設定が
揃うと動作します。

> 写真は `drive.file` スコープ（アプリが作成・選択したファイルのみアクセス）で扱います。
> このスコープは Google の OAuth 監査（センシティブスコープ審査）の対象外で、申請なしに
> 本番利用できます。

---

## 全体像

```
ブラウザ ──Google ログイン──▶ Google 同意画面
   │                              │ 認可コード
   ▼                              ▼
/auth/callback ──exchangeCodeForSession──▶ Supabase Auth（セッション発行）
   │ provider_refresh_token を暗号化して
   ▼ google_credentials に保存
画像表示・アップロードで refresh token → 短命 access token を発行（サーバー）
```

設定するものは 3 つです。

1. **Google Cloud**: OAuth クライアント（Client ID / Secret）と同意画面
2. **Supabase**: Google プロバイダを有効化し、上記 Client ID / Secret を設定
3. **環境変数**: `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `TOKEN_ENC_KEY`

---

## 1. Google Cloud で OAuth クライアントを作る

[Google Cloud Console](https://console.cloud.google.com/) で作業します。

### 1-1. プロジェクトを用意

- 既存プロジェクトを使うか、新規作成（名前は任意。例: `mfmf`）。

### 1-2. Google Drive API を有効化

- 「API とサービス」▶「ライブラリ」で **Google Drive API** を検索し、**有効にする**。

### 1-3. OAuth 同意画面

- 「API とサービス」▶「OAuth 同意画面」。
- User Type は **External**（外部）。
- アプリ名・サポートメール・デベロッパー連絡先を入力。
- **スコープは追加不要**（`drive.file` は同意画面でのスコープ登録が不要な非センシティブスコープ）。
- 公開ステータス:
  - **テスト**のままなら、利用する Google アカウント（夫婦の 2 つ）を「テストユーザー」に追加すれば使えます。
    refresh token の有効期限が 7 日になる点に注意（期限切れ後は再ログインが必要）。
  - 期限を気にしたくなければ **本番（In production）に公開**します。`drive.file` のみなので
    審査・動画提出は不要で、警告は出ません。

### 1-4. OAuth クライアント ID を作成

- 「API とサービス」▶「認証情報」▶「認証情報を作成」▶「OAuth クライアント ID」。
- アプリケーションの種類: **ウェブアプリケーション**。
- **承認済みのリダイレクト URI** に Supabase のコールバックを追加（次章の値）:
  ```
  https://YOUR_PROJECT_REF.supabase.co/auth/v1/callback
  ```
  `YOUR_PROJECT_REF` は Supabase の Project Ref（プロジェクト URL のサブドメイン）。
- 作成後に表示される **クライアント ID** と **クライアントシークレット** を控える。

> リダイレクト URI は **Supabase の** `/auth/v1/callback` を指定します。アプリ側の
> `/auth/callback` ではありません（アプリ側 URL は次章の Supabase 設定で登録します）。

---

## 2. Supabase で Google プロバイダを有効化

### 2A. リモート Supabase の場合（ダッシュボード）

#### 2A-1. Google プロバイダ

- 「Authentication」▶「Sign In / Providers」（旧 Providers）▶ **Google** を有効化。
- 1-4 で取得した **Client ID** と **Client Secret** を入力して保存。

#### 2A-2. リダイレクト URL の許可

- 「Authentication」▶「URL Configuration」。
- **Site URL** に本番 URL（例: `https://mfmf.example.com`）を設定。
- **Redirect URLs** に、アプリ側コールバックを使う URL を追加:
  ```
  http://localhost:3000/auth/callback
  https://YOUR_APP_DOMAIN/auth/callback
  ```
  （ローカル開発と本番の両方。Vercel のプレビュー URL を使う場合はそれも追加）

### 2B. ローカル Supabase（`supabase start`）の場合

1-4 で Google Cloud に登録する **承認済みのリダイレクト URI** はローカル Supabase 用の値に：

```
http://127.0.0.1:54321/auth/v1/callback
```

`supabase init` が生成した `supabase/config.toml` を開き、`[auth.external.google]` セクションを
編集して `enabled = true` と Client ID / Secret を設定（`env(...)` で `.env` 参照可）：

```toml
[auth.external.google]
enabled = true
client_id = "env(GOOGLE_CLIENT_ID)"
secret = "env(GOOGLE_CLIENT_SECRET)"
redirect_uri = "http://127.0.0.1:54321/auth/v1/callback"
```

ローカル Supabase はプロジェクト直下の `.env` を参照するため、CLI 用に値を渡す軽量な
方法として `supabase/.env` を作成（このファイルは git 無視対象）：

```dotenv
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

設定後、Supabase を再起動：

```bash
supabase stop
supabase start
```

> アプリ側コールバック (`http://localhost:3000/auth/callback`) は `[auth]` セクションの
> `site_url` / `additional_redirect_urls` に追加する設定もあります。`supabase init` の
> デフォルトでは `http://localhost:3000` 系が含まれるので通常はそのまま使えます。

---

## 3. 環境変数を設定

ローカルは `.env.local`、本番は Vercel の環境変数に設定します（[configuration.md](../reference/configuration.md) も参照）。

| 変数 | 値 |
| --- | --- |
| `GOOGLE_CLIENT_ID` | 1-4 のクライアント ID |
| `GOOGLE_CLIENT_SECRET` | 1-4 のクライアントシークレット |
| `TOKEN_ENC_KEY` | 乱数文字列（`just setup` 利用時は自動生成） |

`just setup` を実行した場合は `TOKEN_ENC_KEY` が自動生成・投入されます。
手動で発行する場合：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

> いずれも **サーバー専用**（`NEXT_PUBLIC_` を付けない）。`TOKEN_ENC_KEY` を変更・紛失すると
> 保存済みの refresh token を復号できなくなり、各自の再ログインが必要になります。

---

## 4. データベースを更新

`supabase/migrations/0008_google_credentials.sql` を適用します（連携トークンの保存先）。

- ローカル/CLI: `supabase db push`（または `supabase migration up`）
- リモート直適用する場合は migration の SQL を Supabase の SQL Editor で実行。

---

## 5. 動作確認

1. `npm run dev` で起動し `/login` を開く。
2. 「Google でログイン」▶ 同意画面で **Drive の `drive.file` 許可**に同意。
3. `/`（一覧）に戻ればログイン成功。
4. Supabase の `google_credentials` テーブルに自分の行ができ、`refresh_token_enc` が
   **暗号化された文字列**（平文でないこと）で入っていることを確認。

うまくいかないときは `/login?error=oauth`（認証失敗）や `/login?error=drive`（トークン保存失敗）に
戻ります。Redirect URL の登録漏れ、Client ID/Secret の不一致、`TOKEN_ENC_KEY` 未設定が主な原因です。

---

## 既存ユーザーからの移行について

本アプリはメール/パスワード認証を廃止し **Google 一本化**しました。Google ログインでは
新しい Supabase ユーザー（別の `auth.uid()`）が作られるため、以前の `owner_id` に紐づく
記録・写真は表示されません。写真は Drive へ作り直す方針のため、移行は行いません。

> 旧ログインで残したい記録がある場合は、Drive 連携を完成させる前に手元に控えておいてください。

---

## このあとの実装（参考）

- **Phase 2**: クライアントから Drive へ直接アップロード、`record_photos` を Drive ファイル ID 化。
- **Phase 3**: 画像プロキシ `/api/photo/[fileId]` + CDN キャッシュで表示。
- **Phase 4**: 共有フォルダの設定 UI。

トークン発行のサーバー実装は `src/lib/google/token.ts`、暗号化は `src/lib/google/crypto.ts`。
