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
2. `supabase/migrations/` の SQL を**連番順に** SQL Editor で実行
   （`0001_init.sql` 〜 `0009_share_links.sql` まで）。テーブル / RLS / Storage バケット
   `daycare-photos` が作られます。
3. **Google プロバイダを有効化**してログインを設定。本アプリは Google OAuth 一本化のため、
   メール/パスワードでのログインは使えません。Google Cloud / Supabase の設定手順は
   **[guides/google-drive-setup.md](./guides/google-drive-setup.md)** を参照。

> ⚠️ 本アプリは **1 アカウント共用**の方針です。RLS が `owner_id = auth.uid()` ベースのため、
> 別の Google アカウントでログインすると記録が共有されません。**夫婦で共有する 1 つの Google
> アカウント**で 2 人とも使ってください
> （理由は [design-decisions.md](./explanation/design-decisions.md#共有方針-a-1-アカウント共用)）。

---

## 次に読むもの

- うまく動かない → [guides/local-supabase.md#トラブルシュート](./guides/local-supabase.md#トラブルシュート)
- 構成や仕様を知りたい → [reference/architecture.md](./reference/architecture.md)
- なぜこの構成なのか → [explanation/design-decisions.md](./explanation/design-decisions.md)
