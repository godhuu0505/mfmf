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
- [guides/google-drive-setup.md](./guides/google-drive-setup.md) — Google ログイン / Drive 連携の設定（Google Cloud・Supabase・環境変数）。
- [guides/deploy.md](./guides/deploy.md) — デプロイ・リリース手順（main→Preview、Release→Production）と初回セットアップ。
- [guides/verify-backend.md](./guides/verify-backend.md) — デプロイ済みアプリと Supabase バックエンドの動作確認。
- [guides/feedback-to-issues.md](./guides/feedback-to-issues.md) — ご意見・不具合フォームの内容を非公開リポへ Issue 化する運用。
- [guides/sentry.md](./guides/sentry.md) — Sentry でエラーモニタリング / Web Vitals の p75 を有効化する（任意）。

## リファレンス（reference/）

- [reference/architecture.md](./reference/architecture.md) — 構成の地図（技術スタック・デプロイ構成・ソースの地図）と「正はどこか」の対応表。
- [reference/configuration.md](./reference/configuration.md) — 環境変数と npm スクリプトの一覧。

## 解説（explanation/）

- [explanation/principles.md](./explanation/principles.md) — **Mission / Vision / Values**。個別の決定を導く判断基準（V1〜V7）と、その根拠になった実例。
- [explanation/decisions.md](./explanation/decisions.md) — 設計決定ログ（D ログ）。**却下した案とその理由**を 1 行で残す唯一の場所。
- [explanation/prototype-first.md](./explanation/prototype-first.md) — 新機能の画面を静的プロトタイプ＋Artifact で決める理由（2026-07-30 に実コード案から方針転換した経緯と実測データ）。
- [explanation/roadmap.md](./explanation/roadmap.md) — 将来構想・機能カタログ・フェーズ別ロードマップ（家族共有・権限・Google 統合）。
- [explanation/phase-3-5-use-cases.md](./explanation/phase-3-5-use-cases.md) — Phase 3.5（家族・権限・サインアップ・共有）のユースケース・バックログ（受け入れ条件・決定ログ・未決事項）。

---

- プロジェクト全体像は [../README.md](../README.md)。
- AI コーディングエージェント向けの作業指針は [../AGENTS.md](../AGENTS.md) / [../CLAUDE.md](../CLAUDE.md)。
- DB / RLS の正は [`supabase/migrations/`](../supabase/migrations/)。
