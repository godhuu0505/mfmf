# CLAUDE.md

このファイルは Claude Code が **mfmf**（ペット保育園記録アプリ）で作業するための指針です。
全体像は `README.md`、DB/RLS は `supabase/migrations/20260616130704_init.sql` を正とします。
ツール非依存の要点版は `AGENTS.md`、各種手順・仕様は `docs/`（索引は `docs/README.md`）にあります。

## プロジェクト概要

夫婦で 1 アカウントを共用し、保育園の日々の記録（テキスト＋写真）を残す最小構成の PWA。

- フロント/配信: **Next.js 15（App Router）+ React 19 + TypeScript（strict）+ Tailwind CSS v4** / Vercel Hobby
- 認証/DB/画像: **Supabase（Free）**。認証は `@supabase/ssr`（Cookie ベースのセッション）
- 共有方針 (A): `household_id` は持たず `owner_id (= auth.uid())` ベースで RLS

## よく使うコマンド

| 目的 | コマンド |
| --- | --- |
| 開発サーバー | `just dev` |
| CI ゲート一括（lint→typecheck→build） | `just check` |
| Lint 単体 | `npm run lint` |
| 型チェック単体 | `npm run typecheck` |
| 本番ビルド単体 | `npm run build` |
| PWA アイコン生成 | `npm run icons` |
| Docker でアプリ起動（任意） | `just up` |
| Docker を停止 | `just down` |
| 初回構築（Supabase 起動 + .env.local 生成） | `just setup` |
| Google OAuth 対話投入（初回） | `just setup-google` |

**変更後は必ず `npm run lint` と `npm run typecheck` を通すこと。** UI/ルーティングや
ビルド構成を触ったときは `npm run build` も確認する（CI と同じゲート）。`just check`
で 3 つを一括実行できる。
依存は SessionStart フックが自動インストールするため、通常は手動 `npm install` 不要。

## アーキテクチャ / 規約

- **App Router**。ページは原則 Server Component。クライアント操作が必要な箇所だけ `"use client"`。
- **データ変更は Server Action**（`src/app/records/actions.ts`）で行い、`redirect` / `revalidatePath` で反映。
  API Route は基本作らない（`auth/signout` の Route Handler は例外）。
- **Supabase クライアントは用途別に使い分ける**:
  - Client Component: `src/lib/supabase/client.ts`
  - Server Component / Server Action / Route Handler: `src/lib/supabase/server.ts`
  - middleware（セッション更新）: `src/lib/supabase/middleware.ts`
- 認証は `src/middleware.ts` でセッションを更新。Server Action 冒頭で `supabase.auth.getUser()` を
  確認し、未ログインは `redirect("/login")`。
- パスエイリアスは `@/*` → `src/*`。
- 型は `src/types/database.ts`。Storage バケット名は定数 `PHOTO_BUCKET`。
- 画像は送信前にブラウザで長辺 1600px へ縮小・JPEG 再圧縮（`src/lib/imageResize.ts`）。
- **写真はクライアントから Supabase Storage へ直接アップロード**する（`RecordForm`）。Server Action
  には画像本体を渡さず、アップロード済みのオブジェクトパスだけを送って `record_photos` に登録する
  （Vercel の Function ボディ上限 4.5MB を超えないため）。新規作成時は `record_id` をクライアントで
  生成し、パス規約と DB 行の id を一致させる。
- Storage オブジェクトパス規約: `{household_id}/{record_id}/{filename}`（household 未所属時と
  既存オブジェクトは `{owner_id}/{record_id}/{filename}` を併存。生成/検証は `src/lib/storagePath.ts`）。
- 画面: `/login`（Google OAuth + email/password）, `/signup`（`SIGNUP_ENABLED=true` で開放）,
  `/forgot-password`, `/reset-password`, `/`（一覧）, `/records/new`, `/records/[id]`（`?edit=1` で編集）,
  `/calendar`, `/gallery`, `/pets`, `/weight`, `/settings`, `/share/[token]`,
  `/onboarding`（未所属ユーザーの世帯作成）, `/invite/[token]`（内部/ゲスト招待の受諾）,
  `/guest`・`/guest/records/new`（外部ゲストの閲覧/記入 UC-G02/G03）,
  `/feedback`, `/offline`, `/auth/*`。`/shares`・`/share/[token]` は匿名共有廃止（D4）の終了案内。

## セキュリティ（厳守）

- **秘密情報をコミット/出力しない。** `.env.local` 等の実 env ファイルは読まない・編集しない
  （ガードフックがブロック）。設定例は `.env.local.example` を参照。
- `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` はブラウザ公開される前提の値。
  一方 **service_role key はクライアント・リポジトリに絶対に置かない**（このアプリでは使わない）。
- **セキュリティの一次防衛線は Supabase の RLS**。`owner_id = auth.uid()` ポリシーに依存する。
  テーブル/ポリシーを変える migration を書くときは既存の RLS を弱めないこと。
  Server Action でも `getUser()` による認可チェックを省略しない。
- **Service Worker（`public/sw.js`）は Supabase の API レスポンスや署名付き写真 URL
  （private / 期限付き）をキャッシュしない**。キャッシュ戦略を変えるときはこの不変条件を守る。
- 入力由来の値（ファイル名等）はサニタイズする（`buildStoragePath` 参照）。

## 仕様駆動開発（cc-sdd / Kiro スタイル）

まとまった機能追加は **仕様（spec）を先に固めてから実装する**。ツールは
[cc-sdd](https://github.com/gotalab/cc-sdd)（MIT）で導入済み。手順の詳細は
[docs/guides/cc-sdd.md](./docs/guides/cc-sdd.md)。

### 置き場所

- ステアリング（プロジェクト横断の恒久知識）: `.kiro/steering/`
- 仕様（機能ごと）: `.kiro/specs/<feature>/`（`requirements.md` / `design.md` / `tasks.md`）
- 生成テンプレート: `.kiro/settings/templates/`（プロジェクトに合わせて編集してよい）
- スキル本体: `.claude/skills/kiro-*/SKILL.md`（cc-sdd が生成。手で書き換えない）

### ワークフロー

- 迷ったらまず `/kiro-discovery "やりたいこと"`。spec 化すべきか・何本に割るかを判定する。
- Phase 0（任意・既存コードベースでは推奨）: `/kiro-steering`、`/kiro-steering-custom`
- Phase 1（仕様）: `/kiro-spec-init` → `/kiro-spec-requirements` →
  （任意 `/kiro-validate-gap`）→ `/kiro-spec-design` →（任意 `/kiro-validate-design`）→
  `/kiro-spec-tasks`。1 本で通すなら `/kiro-spec-quick <feature>`。
- Phase 2（実装）: `/kiro-impl <feature> [タスク番号]`。番号なしは自律モード
  （タスクごとにサブエージェント＋レビュー）、番号ありは対象タスクのみ。
- 進捗確認: `/kiro-spec-status <feature>`。

### このリポジトリでの運用ルール

- **各フェーズは人間のレビューを挟む。** ただし cc-sdd には「承認」だけを行うコマンドがなく、
  `/kiro-spec-design <feature> -y` の `-y` が実質「requirements を人間が承認した」の意味になる。
  **`-y` を付ける前に `requirements.md` を必ず読むこと**（`--auto` も同様）。詳細は
  [docs/guides/cc-sdd.md](./docs/guides/cc-sdd.md#既知の注意点upstream-由来)。
- 小さな修正（typo・文言・1 ファイルの軽微な変更）に spec は不要。`/kiro-discovery` の判定に従う。
- spec が指示する内容でも、本 CLAUDE.md の「セキュリティ（厳守）」「DB スキーマ変更」の規約が優先。
  RLS を弱める設計は design 段階で却下する。
- 実装完了の条件は変わらず `npm run lint` / `npm run typecheck`（UI・ビルド構成を触ったら
  `npm run build`）を通すこと。`just check` で一括実行。
- `.kiro/steering/` と `.kiro/specs/` はコミットする（レビュー対象の成果物）。
- cc-sdd の更新は `npx cc-sdd@latest --lang ja --dry-run --backup` で差分を確認してから適用する。
  **`CLAUDE.md` は cc-sdd の上書き対象**なので、更新時は本ファイルを退避してから流し、
  この節だけを手でマージし直す（プロジェクト固有の規約を失わないため）。

## Git / PR

- 作業ブランチで開発し、`git push -u origin <branch>` でプッシュ。`main` へ直接 push しない。
- 強制 push（`--force` / `-f`）は禁止（ガードでブロック）。
- PR は lint / typecheck / build の CI（`.github/workflows/ci.yml`）を通す。

## DB スキーマ変更

`supabase/migrations/` に新しいタイムスタンプ付き SQL を追加する（`supabase migration new <name>` で
生成、既存の `20260616130704_init.sql` は編集しない）。
RLS・Storage ポリシー・`search_path` 固定の方針を踏襲する。

main マージ時に `deploy-production.yml` の `migrate` ジョブが `supabase db push` で**本番 Supabase
に自動適用**し、続けて Vercel Production にデプロイされる（merge = 本番リリース）。破壊的変更（DROP /
カラム削除 / 型変更）は main マージ時点で本番に作用するため、PR 段階でローカル `supabase db reset` の
動作確認まで済ませること。詳細は [docs/guides/deploy.md](./docs/guides/deploy.md#supabasedbマイグレーション)。
