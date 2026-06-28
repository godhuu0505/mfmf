# mfmf

> ペット保育園記録アプリ（フェーズ1）— 保育園からの日々の記録（テキスト＋写真）を残し、夫婦で振り返るためのミニマムな PWA。

[![CI](https://github.com/godhuu0505/mfmf/actions/workflows/ci.yml/badge.svg)](https://github.com/godhuu0505/mfmf/actions/workflows/ci.yml)
![Next.js](https://img.shields.io/badge/Next.js-15-black)
![Supabase](https://img.shields.io/badge/Supabase-Free-3ECF8E)

夫婦で 1 アカウントを共用し、保育園とおうち（両親）どちらのノートも同じ仕組みで記録します。
フロントは **Next.js（App Router）/ Vercel**、バックエンド（認証・DB・画像）は **Supabase**。
どちらも無料枠で完結します。

## クイックスタート

本アプリは **Google OAuth 一本化**（メール/パスワードログインは使えません）。
どのルートを選んでも、Google Cloud Console での OAuth クライアント発行が必須です。

### A. リモート Supabase に繋ぐ（最短）

クラウド上の Supabase プロジェクトを使う場合：

```bash
git clone https://github.com/godhuu0505/mfmf.git
cd mfmf
npm install

cp .env.local.example .env.local   # Supabase の URL / anon key を設定
just dev                           # http://localhost:3000
```

詳しい手順（Supabase プロジェクト発行と Google プロバイダ設定含む）は
**[docs/getting-started.md](./docs/getting-started.md)**。

### B. ローカル Supabase スタックを使う（推奨）

Docker（Docker Desktop / Rancher Desktop など）と `just` / Supabase CLI を導入：

```bash
brew install just supabase/tap/supabase
git clone https://github.com/godhuu0505/mfmf.git && cd mfmf
npm install
```

**初回 1 回だけ** Google Cloud Console で **OAuth クライアント**を発行します（約 5 分）。
リダイレクト URI に `http://127.0.0.1:54321/auth/v1/callback` を登録（`localhost` ではなく
`127.0.0.1`）。発行手順は [docs/guides/google-drive-setup.md](./docs/guides/google-drive-setup.md) 1 章。

その後、コマンド 3 つで起動できます：

```bash
just setup           # Supabase 起動 + .env.local 自動生成（URL/anon key/TOKEN_ENC_KEY）
just setup-google    # CLIENT_ID/SECRET を対話入力 → 全箇所に投入 + Supabase 再起動
just up              # docker compose で Next.js 起動（CI と同じ Node 22）
# または just dev でホスト Node 起動
```

詳細・トラブルシュートは **[docs/guides/local-supabase.md](./docs/guides/local-supabase.md)**。

### よく使う just コマンド

```bash
just                # 利用可能な recipe を一覧
just dev            # ホスト Node で next dev
just up             # docker compose で Next.js をコンテナ起動
just down           # コンテナを停止
just check          # lint → typecheck → build（CI と同じゲート）
just setup          # 初回のみ：ローカル Supabase 起動 + .env.local 生成
just setup-google   # 初回のみ：Google OAuth 認証情報を対話投入
```

## 主な機能

- **記録の CRUD** — 日付＋本文。一覧（サムネ＋抜粋）/ 詳細 / 編集 / 削除。
- **検索・絞り込み・並び替え** — 本文・記入者のキーワード検索（`pg_trgm`）、記録元・期間での絞り込み、日付/体重での並び替え、ページネーション。条件は URL クエリ（`?q=&from=&to=&source=&sort=&page=`）に同期され、共有・リロードで再現できる。
- **写真の紐付け** — 1 記録に複数枚。クライアントから Supabase Storage へ直接アップロード。
- **記録メタデータ** — 記録元（🏫 保育園 / 🏠 おうち）・記入者・体重(kg)。記録元で絞り込み、体重は推移グラフへ。
- **PWA** — ホーム画面に追加、スタンドアロン表示、オフラインフォールバック。
- **ご意見・不具合フォーム** — どの画面からでも送信。内容は Supabase にのみ保存（GitHub には送らない）。

## ドキュメント

詳細は **[docs/](./docs/README.md)** に [Diátaxis](https://diataxis.fr/) で整理しています。

| 知りたいこと | ドキュメント |
| --- | --- |
| まず動かす | [docs/getting-started.md](./docs/getting-started.md) |
| ローカル Supabase / つまずき | [docs/guides/local-supabase.md](./docs/guides/local-supabase.md) |
| デプロイ・リリース | [docs/guides/deploy.md](./docs/guides/deploy.md) |
| 動作確認 | [docs/guides/verify-backend.md](./docs/guides/verify-backend.md) |
| 構成・データモデル・環境変数 | [docs/reference/](./docs/reference/architecture.md) |
| 設計の「なぜ」 | [docs/explanation/design-decisions.md](./docs/explanation/design-decisions.md) |

AI コーディングエージェント向けの作業指針は [AGENTS.md](./AGENTS.md) / [CLAUDE.md](./CLAUDE.md)。

## ライセンス

私的利用のためのプロジェクトです。
