# mfmf ドキュメント

mfmf のドキュメントは [Diátaxis](https://diataxis.fr/) に倣い、読み手の目的別に
4 つに分類しています。「いま何をしたいか」から入口を選んでください。

| 目的 | 分類 | ドキュメント |
| --- | --- | --- |
| **まず動かしたい**（初めての人向けの一本道） | チュートリアル | [getting-started.md](./getting-started.md) |
| **特定の作業をやり遂げたい**（手順書） | ハウツー | [guides/](#ハウツーguides) |
| **仕様・構成を調べたい**（事実の参照） | リファレンス | [reference/](#リファレンスreference) |
| **設計の背景や「なぜ」を理解したい** | 解説 | [explanation/](#解説explanation) |

## チュートリアル

- [getting-started.md](./getting-started.md) — リモート Supabase に繋いでローカルで動かすまでの最短手順。

## ハウツー（guides/）

- [guides/local-supabase.md](./guides/local-supabase.md) — Supabase CLI でローカルスタックを立てる / トラブルシュート。
- [guides/deploy.md](./guides/deploy.md) — デプロイ・リリース手順（main→Preview、Release→Production）と初回セットアップ。
- [guides/verify-backend.md](./guides/verify-backend.md) — デプロイ済みアプリと Supabase バックエンドの動作確認。
- [guides/feedback-to-issues.md](./guides/feedback-to-issues.md) — ご意見・不具合フォームの内容を非公開リポへ Issue 化する運用。

## リファレンス（reference/）

- [reference/architecture.md](./reference/architecture.md) — 技術スタック・画面・データモデル・RLS・Storage。
- [reference/configuration.md](./reference/configuration.md) — 環境変数と npm スクリプトの一覧。

## 解説（explanation/）

- [explanation/design-decisions.md](./explanation/design-decisions.md) — 共有方針・スコープ・PWA・セキュリティ・デプロイ方針の「なぜ」。

---

- プロジェクト全体像は [../README.md](../README.md)。
- AI コーディングエージェント向けの作業指針は [../AGENTS.md](../AGENTS.md) / [../CLAUDE.md](../CLAUDE.md)。
- DB / RLS の正は [`supabase/migrations/`](../supabase/migrations/)。
