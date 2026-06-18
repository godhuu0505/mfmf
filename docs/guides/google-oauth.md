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
| Vercel Preview | `https://*-<team-or-account-slug>.vercel.app/**`（自分のチーム / アカウント slug に限定） |
| 本番 | `https://YOUR_PRODUCTION_DOMAIN/auth/callback` |

> ⚠️ **`https://*.vercel.app/...` のような広いワイルドカードは登録しないでください。**
> `NEXT_PUBLIC_SUPABASE_URL` / anon key は公開値のため、広すぎる許可リストだと
> **無関係な別の Vercel アプリ**がこの Supabase プロジェクト向けの OAuth フローを開始し、
> コールバックを横取り（`code` を交換）できてしまいます。Supabase の `*` は区切り以外の
> 任意文字にマッチするため、プレビューは **自分のプロジェクト固有のプレフィックス**で
> 絞り込みます（例: `https://mfmf-<slug>-*.vercel.app/**`）。確実を期すなら
> プレビュー固有のドメインを**完全一致**で登録してください。
>
> アプリは `window.location.origin + /auth/callback` を `redirectTo` に渡すため、
> アクセス元のオリジンに対応する URL を登録しておく必要があります。
> Site URL（既定の戻り先）も併せて本番ドメインに設定しておくと安全です。

## 4. 動作確認

1. ログイン画面で「Google で続行」を押す。
2. Google の同意画面 → `/auth/v1/callback`（Supabase）→ アプリの `/auth/callback`
   へ戻り、`code` がセッションに交換されて一覧（`/`）へ遷移すれば成功。
3. 失敗時は `/login?error=oauth` に戻り、ログイン画面にエラーが表示されます。

## ⚠️ 重要: 共有する 1 つの Google アカウントで使う

本アプリは共有方針 **(A) 夫婦で 1 アカウント共用**（`owner_id = auth.uid()`、世帯概念なし）です。
**各自が別々の Google アカウントでログインすると、それぞれ別の `auth.uid()` になり、
相手の記録・写真が一切見えなくなります**（別々の空データセットになる）。

- Google ログインは、**ご夫婦で共有する 1 つの Google アカウント**でのみ使ってください。
- 既存のメール / パスワード共有アカウントと**同じ人物（同じデータ）**として使いたい場合は、
  当面はメール / パスワードログインの利用を推奨します（Google は別 `auth.uid()` になり得るため）。
- 複数ユーザーでの世帯共有・個別アカウントは **Phase 4「世帯共有（household_id）」(#33)** で
  対応予定です。それまでは 1 共有アカウント運用を維持します。
- 運用を厳密にしたい場合は、Google Cloud の OAuth 同意画面で**テストユーザーを共有
  アカウントのみ**に限定すると、想定外のアカウントでのログインを抑止できます。

## 補足

- 認証方式が増えても **RLS（`owner_id = auth.uid()`）は不変**です。Google でログインした
  ユーザーも同じ `auth.uid()` ベースで自分の記録のみアクセスできます。
- 既存のメール / パスワードログインはそのまま併用できます。
