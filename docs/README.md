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
- [guides/deploy.md](./guides/deploy.md) — main→Cloud Run本番配信、DB更新・復旧の境界、旧構成の参照手順。
- [guides/gcp-database-deployment.md](./guides/gcp-database-deployment.md) — GCP DB/Auth通常配信と、未適用SQLのbackup保持gate。
- [guides/gcp-backup-automation.md](./guides/gcp-backup-automation.md) — 日次IdP暗号化保全、SQL保持receipt、復元と費用の境界。
- [guides/database-auth-backup.md](./guides/database-auth-backup.md) — 元Supabaseのpublic/Auth原本保全と、明示的なfreeze/unfreeze。
- [guides/cloud-run-candidate.md](./guides/cloud-run-candidate.md) — WIF で候補イメージと公開設定を準備し、サーバーの秘密を Secret Manager へ移す。
- [guides/cloud-run-continuous.md](./guides/cloud-run-continuous.md) — 初期無効の Cloud Run 継続配信、固定 secret 参照、旧 traffic を維持した検証と切り替え。
- [guides/verify-backend.md](./guides/verify-backend.md) — デプロイ済みアプリと Supabase バックエンドの動作確認。
- [guides/feedback-to-issues.md](./guides/feedback-to-issues.md) — ご意見・不具合フォームの内容を非公開リポへ Issue 化する運用。
- [guides/gcp-migration-preflight.md](./guides/gcp-migration-preflight.md) — 外部接続なしの移行棚卸しとP2のStorage認可境界。
- [guides/storage-manifest-reconciliation.md](./guides/storage-manifest-reconciliation.md) — 架空の画像manifestをオフラインで照合するCLIと、結果を移行合格にしない境界。
- [guides/storage-operator-backup.md](./guides/storage-operator-backup.md) — 運用専用の固定source一覧取得、画像本体のage暗号化保全と全件byte検証。
- [guides/storage-migration-operator.md](./guides/storage-migration-operator.md) — GCSへの段階移送、独立復元、同時CAS切替/rollback、terminal ledgerの定期回収。
- [guides/genai-ranking-experiment.md](./guides/genai-ranking-experiment.md) — 架空の日本語記録だけを使うRanking APIのCLI実験・実測・料金。
- [guides/related-records.md](./guides/related-records.md) — 明示操作による関連度検索、送信範囲・権限・期限・課金枠・テスト。
- [guides/sentry.md](./guides/sentry.md) — Sentry でエラーモニタリング / Web Vitals の p75 を有効化する（任意）。

## リファレンス（reference/）

- [reference/architecture.md](./reference/architecture.md) — 構成の地図（技術スタック・デプロイ構成・ソースの地図）と「正はどこか」の対応表。
- [reference/configuration.md](./reference/configuration.md) — 環境変数と npm スクリプトの一覧。

## 解説（explanation/）

- [explanation/principles.md](./explanation/principles.md) — **Mission / Vision / Values**。個別の決定を導く判断基準（V1〜V7）と、その根拠になった実例。
- [explanation/decisions.md](./explanation/decisions.md) — 設計決定ログ（D ログ）。**却下した案とその理由**を 1 行で残す唯一の場所。
- [explanation/prototype-first.md](./explanation/prototype-first.md) — 新機能の画面を静的プロトタイプ＋Artifact で決める理由（2026-07-30 に実コード案から方針転換した経緯と実測データ）。
- [explanation/mobile-app-tech-selection.md](./explanation/mobile-app-tech-selection.md) — **Android / iOS アプリ化の技術選定**（7 案 × 7 観点の重み付き評価と、PWA 継続を選んだ理由・覆す条件）。
- [explanation/gcp-migration.md](./explanation/gcp-migration.md) — **GCP段階移行計画（D38）**。月額の前提、P0 / P1の完了条件、認可・復元・切替の検証。
- [explanation/gcp-tech-selection.md](./explanation/gcp-tech-selection.md) — GCP移行の技術選定と見送った構成。
- [explanation/roadmap.md](./explanation/roadmap.md) — 将来構想・機能カタログ・フェーズ別ロードマップ（家族共有・権限・Google 統合）。
- [explanation/phase-3-5-use-cases.md](./explanation/phase-3-5-use-cases.md) — Phase 3.5（家族・権限・サインアップ・共有）のユースケース・バックログ（受け入れ条件・決定ログ・未決事項）。

## アーカイブ（archive/）

- [archive/](./archive/) — 役目を終えたプロトタイプとスペック。**現状の仕様ではなく**、合意した時点のスナップショット（[D27](./explanation/decisions.md)）。現役のプロトタイプは [`proto/`](../proto/)。

---

- プロジェクト全体像は [../README.md](../README.md)。
- AI コーディングエージェント向けの作業指針は [../AGENTS.md](../AGENTS.md) / [../CLAUDE.md](../CLAUDE.md)。
- DB / RLS の正は [`supabase/migrations/`](../supabase/migrations/)。
