# はじめての起動（チュートリアル）

クラウド上の Supabase に繋いで、mfmf をローカルで動かすまでの**一本道**です。
途中で迷わないよう、推奨ルート（リモート Supabase）だけを扱います。
ローカルに Supabase スタックを立てたい・困ったときは
[guides/local-supabase.md](./guides/local-supabase.md) を参照してください。

## 前提

- Node.js 20 LTS 以上（`node -v` で確認）
- アクセスできる Supabase プロジェクト（無い場合は下の「Supabase を用意する」を先に実施）

## 1. クローンと依存インストール

```bash
git clone https://github.com/godhuu0505/mfmf.git
cd mfmf
npm install
```

## 2. 環境変数を設定

```bash
cp .env.local.example .env.local
```

`.env.local` に Supabase の接続情報を設定します。値は Supabase ダッシュボードの
**Project Settings > API** から取得します。

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://<PROJECT_REF>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon または publishable key>
```

> anon キーはクライアントに露出する前提の公開鍵です（[なぜ公開してよいか](./explanation/design-decisions.md#セキュリティ)）。
> `service_role` キーは絶対に置かないでください。

## 3. 開発サーバーを起動

```bash
just dev   # http://localhost:3000
```

ブラウザで http://localhost:3000 を開き、`/login` でログインできれば成功です。

---

## docker compose での起動（任意）

ローカルマシンの Node.js バージョンを気にせず CI と同じ Node.js 22 で起動したい場合は、
`docker compose` でアプリだけをコンテナ起動できます（Supabase は引き続きクラウド or
`supabase start` を利用）。

```bash
just up      # Docker でアプリ起動
just down    # 停止
```

### 接続先 Supabase の指定

- **クラウド Supabase に繋ぐ**: そのまま `.env.local` の値で OK。
- **ローカル Supabase（`supabase start`）に繋ぐ**: コンテナ内からホストの
  `127.0.0.1:54321` に届かないため、`.env.local` を以下のように上書きする。

  ```dotenv
  NEXT_PUBLIC_SUPABASE_URL=http://host.docker.internal:54321
  ```

  ただし `NEXT_PUBLIC_*` はブラウザにも露出する値です。ブラウザは `host.docker.internal`
  を解決できないため、Mac で Docker 経由のアプリを使うときはローカル Supabase より
  クラウド Supabase の方が素直です。本格的にコンテナ前提で開発するなら Supabase も
  同じ compose ネットワークに置く構成を検討してください（現状はスコープ外）。

---

## Supabase を用意する（初回のみ）

繋ぐ先の Supabase プロジェクトがまだ無い場合だけ実施します。

1. [Supabase ダッシュボード](https://supabase.com/dashboard) で新規プロジェクトを作成。
2. `supabase/migrations/` の SQL を本番 DB に適用：
   - **推奨**: CLI で一括適用
     ```bash
     supabase link --project-ref <PROJECT_REF>
     supabase db push
     ```
   - **代替**: `supabase/migrations/` の SQL を**すべて・タイムスタンプ順に** SQL Editor で実行。
     **一部だけ適用しない**（`20260616130704_init.sql` から最新まで全部）。
     世帯まわりは後半の migration で入るため、初期分だけだと下の「世帯で共有」が動きません
     —— `households` / `household_members` は `20260630130000_households.sql`、
     `/onboarding` が呼ぶ `create_own_household` は `20260704120000_household_provisioning.sql` が初出で、
     欠けると新規ユーザーが世帯を作れずセットアップを完了できません。
   - テーブル / RLS / Storage バケット `daycare-photos` が作られます。
   - **これ以降**に追加される migration は CI/CD が自動適用します
     （仕組みは [guides/deploy.md](./guides/deploy.md#supabasedbマイグレーション)）。
   - ⚠️ **SQL Editor で適用した場合は、適用済みとして記録する必要があります。**
     SQL Editor の実行は `supabase_migrations.schema_migrations` に履歴を残さないため、
     次の CI/CD の `supabase db push` が**初期 migration を未適用と判断して再実行し、
     既存オブジェクトで失敗します**。適用した各バージョンについて実行してください:
     ```bash
     supabase link --project-ref <PROJECT_REF>
     supabase migration repair --status applied <version>   # 例: 20260616130704
     ```
     この手間を避けたいなら **CLI（`supabase db push`）で適用する**のが確実です
     （履歴が自動で記録されます）。
3. **ログイン方式を設定**（どちらか一方でよい）。
   - **メール/パスワード**: Authentication → Providers で Email を有効化。
     さらに **Authentication → URL Configuration** に以下を登録します（**必須**）。
     アプリは確認メールとパスワード再設定の戻り先を `window.location.origin` から作るため
     （`src/app/signup/SignupForm.tsx` / `src/app/forgot-password/page.tsx`）、
     許可されていない戻り先は弾かれ、**確認リンクを踏んでもセッションにならず、
     再設定リンクは `/reset-password` に届きません**。
     - **Site URL**: 本番 URL（例 `https://<YOUR_APP_DOMAIN>`）
     - **Redirect URLs**:
       ```
       https://<YOUR_APP_DOMAIN>/auth/callback
       https://<YOUR_APP_DOMAIN>/auth/callback?next=/reset-password
       http://localhost:3000/auth/callback
       http://localhost:3000/auth/callback?next=/reset-password
       ```
       （Vercel のプレビュー URL も使うならそれも追加）

     自分のアカウントを作るには `.env.local` に `SIGNUP_ENABLED=true` を設定して
     `/signup` を開く（**アプリを起動する前に設定**。起動後に変えた場合は再起動が必要）。

     🔒 **アカウントを作り終えたら、Supabase 側の signup も閉じてください。**
     `SIGNUP_ENABLED` が閉じるのは**アプリの UI/導線だけ**で、Supabase Auth の
     signup API は開いたままです（`src/lib/signup.ts` の注記のとおり）。
     そのままだと**誰でも直接アカウントを作れます**。
     Authentication → Providers → Email の **Allow new users to sign up** を **off** に
     （ローカルは `supabase/config.toml` の `[auth.email] enable_signup`）。
     以降メンバーを増やすときは `/settings` からの**招待**を使います。
   - **Google**: Authentication → Providers で Google を有効化。Google Cloud / Supabase の
     設定手順は **[guides/google-drive-setup.md](./guides/google-drive-setup.md)** を参照
     （Drive 連携を使う場合はこちらが必要）。

> 💡 記録は **世帯（household）** 単位で共有されます。家族は owner / editor / viewer の
> 3 役で招待でき（`/settings`）、保育園やシッターは対象ペット・期間を限定した
> **外部ゲスト**として招けます。別アカウントでも、同じ世帯に招待すれば記録を共有できます。

---

## 次に読むもの

- うまく動かない → [guides/local-supabase.md#トラブルシュート](./guides/local-supabase.md#トラブルシュート)
- 構成や仕様を知りたい → [reference/architecture.md](./reference/architecture.md)
- なぜこの構成なのか → [explanation/design-decisions.md](./explanation/design-decisions.md)
