# AGENTS.md

AI コーディングエージェント（Claude Code / Copilot / Cursor / Codex など）向けの作業指針です。
**詳細な規約の正は [CLAUDE.md](./CLAUDE.md)** にあります。重複を避けるため、ここでは要点と入口だけを示します。
作業前に CLAUDE.md と関連ドキュメントに必ず目を通してください。

## プロジェクト概要

夫婦で 1 アカウントを共用し、保育園の日々の記録（テキスト＋写真）を残すミニマムな PWA。

- フロント/配信: Next.js 15（App Router）+ React 19 + TypeScript(strict) + Tailwind CSS v4 / Vercel
- 認証/DB/画像: Supabase（`@supabase/ssr`、Cookie ベースのセッション）
- 共有方針: `household_id` は持たず `owner_id (= auth.uid())` ベースの RLS

## セットアップ・検証コマンド

```bash
npm install         # 依存（web セッションでは SessionStart フックが自動実行）
just dev            # 開発サーバー
just check          # lint → typecheck → build（CI と同じゲート）
just up             # Docker でアプリ起動（任意）
just down           # Docker を停止
just setup          # 初回のみ：ローカル Supabase 起動 + .env.local 生成
just setup-google   # 初回のみ：Google OAuth 認証情報を対話投入
```

個別に走らせたいときだけ `npm run lint` / `npm run typecheck` / `npm run build` を直接呼ぶ。

**変更後は必ず lint と typecheck を通す。** UI / ルーティング / ビルド構成を触ったときは
build も確認する（CI = `.github/workflows/ci.yml` と同じゲート）。`just check` で 3 つを一括実行できる。

## やってよいこと / 規約

- データ変更は **Server Action**（`src/app/records/actions.ts`）で行い、`redirect` / `revalidatePath` で反映する。
- Supabase クライアントは用途別に使い分ける（Client: `src/lib/supabase/client.ts` / Server: `server.ts` / middleware: `middleware.ts`）。
- Server Action 冒頭で `supabase.auth.getUser()` を確認し、未ログインは `redirect("/login")`。
- DB スキーマ変更は `supabase/migrations/` に新しいタイムスタンプ付き SQL を追加する（`supabase migration new <name>` で生成、既存の `20260616130704_init.sql` は編集しない）。main マージ時に `deploy-preview.yml` の `migrate` ジョブが `supabase db push` で本番 Supabase に自動適用する（preview / production は同一プロジェクト共有）。破壊的変更は PR 段階でローカル `supabase db reset` 確認まで済ませること。
- パスエイリアスは `@/*` → `src/*`。

## やってはいけないこと（境界）

- **秘密情報をコミット / 出力しない。** `.env.local` 等の実 env ファイルは読まない・編集しない（ガードフックがブロック）。
- **`service_role` キーをクライアント・リポジトリに置かない**（このアプリでは使わない）。
- **既存の RLS（`owner_id = auth.uid()`）を弱めない。** Server Action の認可チェックを省略しない。
- **Service Worker（`public/sw.js`）は Supabase の API レスポンスや署名付き写真 URL をキャッシュしない。**
- `main` へ直接 push しない。強制 push（`--force`）禁止（ガードでブロック）。

## ドキュメント地図

- 全体像: [README.md](./README.md) ／ ドキュメント索引: [docs/README.md](./docs/README.md)
- 構成・データモデル: [docs/reference/architecture.md](./docs/reference/architecture.md)
- 設計の「なぜ」: [docs/explanation/design-decisions.md](./docs/explanation/design-decisions.md)
- DB / RLS の正: [supabase/migrations/](./supabase/migrations/)
