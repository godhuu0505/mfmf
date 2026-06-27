# mfmf

> ペット保育園記録アプリ（フェーズ1）— 保育園からの日々の記録（テキスト＋写真）を残し、夫婦で振り返るためのミニマムな PWA。

[![CI](https://github.com/godhuu0505/mfmf/actions/workflows/ci.yml/badge.svg)](https://github.com/godhuu0505/mfmf/actions/workflows/ci.yml)
![Next.js](https://img.shields.io/badge/Next.js-15-black)
![Supabase](https://img.shields.io/badge/Supabase-Free-3ECF8E)

夫婦で 1 アカウントを共用し、保育園とおうち（両親）どちらのノートも同じ仕組みで記録します。
フロントは **Next.js（App Router）/ Vercel**、バックエンド（認証・DB・画像）は **Supabase**。
どちらも無料枠で完結します。

## クイックスタート

```bash
git clone https://github.com/godhuu0505/mfmf.git
cd mfmf
npm install

cp .env.local.example .env.local   # Supabase の URL / anon key を設定
npm run dev                        # http://localhost:3000
```

`.env.local` の値の取り方、Supabase プロジェクトとユーザーの用意を含む詳しい手順は
**[docs/getting-started.md](./docs/getting-started.md)** を参照してください。

## 主な機能

- **記録の CRUD** — 日付＋本文。一覧（サムネ＋抜粋）/ 詳細 / 編集 / 削除。一覧は本文・記入者のキーワード検索、記録元・期間での絞り込み、日付/体重での並び替え、ページネーションに対応（条件は URL クエリ `?q=&from=&to=&source=&sort=&page=` に同期され、共有・リロードで再現できる）。
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
