# AGENTS.md

AI コーディングエージェント（Claude Code / Copilot / Cursor / Codex など）向けの作業指針です。
**詳細な規約の正は [CLAUDE.md](./CLAUDE.md)** にあります。重複を避けるため、ここでは要点と入口だけを示します。
作業前に CLAUDE.md と関連ドキュメントに必ず目を通してください。

## プロジェクト概要

家族で保育園の日々の記録（テキスト＋写真）を残すミニマムな PWA。

- フロント/配信: Next.js 15（App Router）+ React 19 + TypeScript(strict) + Tailwind CSS v4 / Vercel
- 認証/DB/画像: Supabase（`@supabase/ssr`、Cookie ベースのセッション）
- 共有方針: 世帯（`households` / `household_members`）ベースのマルチテナント。
  role は owner / editor / viewer、外部ゲストは `guest_grants`（対象ペット・期間限定）

## セットアップ・検証コマンド

```bash
npm install         # 依存（web セッションでは SessionStart フックが自動実行）
just dev            # 開発サーバー
just check          # lint → typecheck → unit test → build（CI と同じゲート）
just up             # Docker でアプリ起動（任意）
just down           # Docker を停止
just setup          # 初回のみ：ローカル Supabase 起動 + .env.local 生成
just setup-google   # 初回のみ：Google OAuth 認証情報を対話投入
```

個別に走らせたいときだけ `npm run lint` / `npm run typecheck` / `npm run test:unit` /
`npm run build` を直接呼ぶ。

**変更後は必ず lint と typecheck を通す。** UI / ルーティング / ビルド構成を触ったときは
build も確認する（CI = `.github/workflows/ci.yml` と同じゲート）。`just check` で 4 つを一括実行できる。

## やってよいこと / 規約

- データ変更は **Server Action**（`src/app/records/actions.ts`）で行い、`redirect` / `revalidatePath` で反映する。
- Supabase クライアントは用途別に使い分ける（Client: `src/lib/supabase/client.ts` / Server: `server.ts` / middleware: `middleware.ts`）。
- Server Action 冒頭で `supabase.auth.getUser()` を確認し、未ログインは `redirect("/login")`。
- DB スキーマ変更は `supabase/migrations/` に新しいタイムスタンプ付き SQL を追加する（`supabase migration new <name>` で生成、既存の `20260616130704_init.sql` は編集しない）。main マージ時に `deploy-production.yml` の `migrate` ジョブが `supabase db push` で本番 Supabase に自動適用し、続けて Vercel Production にデプロイされる（merge = 本番リリース）。破壊的変更は PR 段階でローカル `supabase db reset` 確認まで済ませること。
- パスエイリアスは `@/*` → `src/*`。
- UI のある新機能は、仕様を文章で固める前に **静的 HTML/CSS/JS のプロトタイプ**を `proto/<slug>/` に作り、
  **Claude Artifact に publish してスマホで触って**合意する（D24。**実コードでプロトを作らない** ——
  実 Storage への書き込み等が起きた実績がある）。手順は `.claude/skills/prototype/SKILL.md`。
  合意時に受け入れ条件を洗い出し E2E テストにする（D25）。結論は
  [docs/explanation/decisions.md](./docs/explanation/decisions.md) に 1 行残す。

## やってはいけないこと（境界）

- **秘密情報をコミット / 出力しない。** `.env.local` 等の実 env ファイルは読まない・編集しない（ガードフックがブロック）。
- **`service_role` キーをクライアント・リポジトリに置かない**（このアプリでは使わない）。
- **既存の RLS（世帯メンバーシップ + role、ゲストは `guest_grants`）を弱めない。**
  Server Action は冒頭で必ず `getUser()`。認可は**操作に応じて使い分ける**（ひとつのヘルパーで
  代用しない）。**対応表は持たない** —— 正は `src/lib/household.ts` と各 `actions.ts`。
  取り違えやすい点だけ: **更新/削除は「現在世帯」ではなく「対象行の `household_id`」で判定する。**
  `/onboarding` は世帯未所属で走るのが正常。詳細は CLAUDE.md。
- **Service Worker（`public/sw.js`）は Supabase の API レスポンスや署名付き写真 URL をキャッシュしない。**
- `main` へ直接 push しない。強制 push（`--force`）禁止（ガードでブロック）。

## ドキュメント地図

- **判断基準（Mission / Vision / Values）**: [docs/explanation/principles.md](./docs/explanation/principles.md)
- 全体像: [README.md](./README.md) ／ ドキュメント索引: [docs/README.md](./docs/README.md)
- 構成の地図: [docs/reference/architecture.md](./docs/reference/architecture.md)
- 決定ログ（却下した案と理由）: [docs/explanation/decisions.md](./docs/explanation/decisions.md)
- DB / RLS の正: [supabase/migrations/](./supabase/migrations/)
