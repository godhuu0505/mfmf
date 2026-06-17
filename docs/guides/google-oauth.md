# Google ログイン（OAuth）の設定

ログイン画面の「Google で続行」を有効にするための手順です。アプリ側の実装
（`/auth/callback` の Route Handler と `signInWithOAuth`）は導入済みなので、
**Supabase ダッシュボードと Google Cloud 側の設定だけ**で利用できます。

> セキュリティ: Google の **client secret はリポジトリ / クライアントに置きません**。
> Supabase ダッシュボードにのみ登録します（アプリの env には不要）。

## 1. Google Cloud で OAuth クライアントを作成

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作成（または選択）。
2. **APIs & Services → OAuth consent screen** を構成（External でよい。テスト中は
   テストユーザーに夫婦のアカウントを追加）。
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID** を作成。
   - Application type: **Web application**
   - **Authorized redirect URIs** に Supabase のコールバック URL を登録:
     `https://YOUR_PROJECT_REF.supabase.co/auth/v1/callback`
4. 発行された **Client ID** と **Client secret** を控える。

## 2. Supabase で Google プロバイダを有効化

1. Supabase ダッシュボード → **Authentication → Providers → Google** を開く。
2. **Google enabled** をオンにし、上で取得した **Client ID / Client secret** を入力して保存。
   - client secret はここ（Supabase 側）にのみ保存する。

## 3. リダイレクト URL を環境ごとに登録

Supabase ダッシュボード → **Authentication → URL Configuration → Redirect URLs** に、
アプリ側コールバック（`/auth/callback`）を**各環境ぶん**登録します。
未登録の URL へはリダイレクトが拒否されます。

| 環境 | 登録する Redirect URL |
| --- | --- |
| ローカル開発 | `http://localhost:3000/auth/callback` |
| Vercel Preview | `https://*.vercel.app/auth/callback`（またはプレビュー固有のドメイン） |
| 本番 | `https://YOUR_PRODUCTION_DOMAIN/auth/callback` |

> アプリは `window.location.origin + /auth/callback` を `redirectTo` に渡すため、
> アクセス元のオリジンに対応する URL を登録しておく必要があります。
> Site URL（既定の戻り先）も併せて本番ドメインに設定しておくと安全です。

## 4. 動作確認

1. ログイン画面で「Google で続行」を押す。
2. Google の同意画面 → `/auth/v1/callback`（Supabase）→ アプリの `/auth/callback`
   へ戻り、`code` がセッションに交換されて一覧（`/`）へ遷移すれば成功。
3. 失敗時は `/login?error=oauth` に戻り、ログイン画面にエラーが表示されます。

## 補足

- 認証方式が増えても **RLS（`owner_id = auth.uid()`）は不変**です。Google でログインした
  ユーザーも同じ `auth.uid()` ベースで自分の記録のみアクセスできます。
- 既存のメール / パスワードログインはそのまま併用できます。
