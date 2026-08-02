# CLAUDE.md

このファイルは Claude Code が **mfmf**（ペット保育園記録アプリ）で作業するための指針です。
全体像は `README.md`、DB/RLS は `supabase/migrations/` 全体（連番 SQL）を正とします。
ツール非依存の要点版は `AGENTS.md`、各種手順・仕様は `docs/`（索引は `docs/README.md`）にあります。

## プロジェクト概要

家族で保育園の日々の記録（テキスト＋写真）を残す最小構成の PWA。

- フロント/配信: **Next.js 15（App Router）+ React 19 + TypeScript（strict）+ Tailwind CSS v4** / Vercel Hobby
- 認証/DB/画像: **Supabase（Free）**。認証は `@supabase/ssr`（Cookie ベースのセッション）
- 共有方針: **世帯（`households` / `household_members`）ベースのマルチテナント**。
  role は owner / editor / viewer、外部ゲストは `guest_grants`（対象ペット・期間限定）。
  ヘルパーは `src/lib/household.ts`（`getCurrentHouseholdId` / `requireEditableHousehold` ほか）。

## よく使うコマンド

| 目的 | コマンド |
| --- | --- |
| 開発サーバー | `just dev` |
| CI ゲート一括（lint→typecheck→unit test→build） | `just check` |
| Lint 単体 | `npm run lint` |
| 型チェック単体 | `npm run typecheck` |
| Unit テスト単体（Vitest / `tests/unit/`） | `npm run test:unit` |
| 本番ビルド単体 | `npm run build` |
| PWA アイコン生成 | `npm run icons` |
| Docker でアプリ起動（任意） | `just up` |
| Docker を停止 | `just down` |
| 初回構築（Supabase 起動 + .env.local 生成） | `just setup` |
| Google OAuth 対話投入（初回） | `just setup-google` |

**変更後は必ず `npm run lint` と `npm run typecheck` を通すこと。** `src/lib/` の
純粋関数を触ったときは `npm run test:unit`、UI/ルーティングやビルド構成を触ったときは
`npm run build` も確認する（CI と同じゲート）。`just check` で 4 つを一括実行できる。
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
- Storage オブジェクトパス規約: `{household_id}/{record_id}/{filename}`。生成/検証は
  `src/lib/storagePath.ts`。**新規アップロードはこの形だけが通る** —— 旧規約
  `{owner_id}/{record_id}/{filename}` への insert ポリシーは削除済みで
  （`20260704000000_rbac_switch_and_management.sql`）、既存オブジェクトの
  **読取/削除のみ**が世帯メンバーに開かれている（`daycare_photos_*_shared_owner`）。
- 画面: `/login`（Google OAuth + email/password）, `/signup`（`SIGNUP_ENABLED=true` で開放）,
  `/forgot-password`, `/reset-password`, `/`（一覧）, `/records/new`, `/records/[id]`（`?edit=1` で編集）,
  `/calendar`, `/gallery`, `/pets`, `/weight`, `/settings`, `/share/[token]`,
  `/onboarding`（未所属ユーザーの世帯作成）, `/invite/[token]`（内部/ゲスト招待の受諾）,
  `/guest`・`/guest/records/new`（外部ゲストの閲覧/記入 UC-G02/G03）,
  `/feedback`, `/offline`, `/auth/*`。`/shares`・`/share/[token]` は匿名共有廃止（D4）の終了案内。

## 新機能の画面を検討するとき

UI のある新機能は、仕様を文章で固める前に **自己完結した静的 HTML/CSS/JS のプロトタイプ**を
`proto/<slug>/` に作り、**Claude Artifact に publish してスマホで触って合意**する（D24）。
CSS は Tailwind CLI に `@source` でその HTML を渡して生成し、本番と同じトークン・
ダークモード・セーフエリアを使う。手順は **`prototype` skill**（`.claude/skills/prototype/`）。

- **実コードでプロトを作らないこと。** 実 Storage への書き込み・実テーブルへの insert・
  実セッションのログアウトが起きた実績がある（旧 D15 を D24 で上書き）
- 合意時に受け入れ条件を洗い出し、**E2E テスト**にする（D25）
- バックエンドのみの変更・既存画面の小改修・バグ修正では使わない
- 採用/却下の結論は [docs/explanation/decisions.md](./docs/explanation/decisions.md) に 1 行残す

## セキュリティ（厳守）

- **秘密情報をコミット/出力しない。** `.env.local` 等の実 env ファイルは読まない・編集しない
  （ガードフックがブロック）。設定例は `.env.local.example` を参照。
- `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` はブラウザ公開される前提の値。
  一方 **service_role key はクライアント・リポジトリに絶対に置かない**（このアプリでは使わない）。
- **セキュリティの一次防衛線は Supabase の RLS**。判定は**世帯メンバーシップと role**
  （`has_household_role` / `is_household_member`）＋ ゲストは `guest_grants` の対象/期間。
  一部の経路で `owner_id = auth.uid()` が併存する（世帯未所属時のフォールバック等）。
  テーブル/ポリシーを変える migration を書くときは既存の RLS を弱めないこと。
  テナント分離は `supabase/tests/` の pgTAP が CI で守っている。
- **Server Action は冒頭で必ず `getUser()`。認可はそのうえで「操作に応じたもの」を使う**
  （ひとつのヘルパーで代用しない）。**どのヘルパーがどの操作用かは
  [`src/lib/household.ts`](src/lib/household.ts) と各 `actions.ts` を読むこと** ——
  ここに対応表を持つとコードと二重管理になり、実際にこの表は 2 度間違えた（D16）。
  取り違えやすい 1 点だけ書いておく: **更新 / 削除は「現在世帯」ではなく「対象行の
  `household_id`」で判定する。** 複数世帯に属するユーザーが別タブで世帯を切り替えていると、
  現在世帯基準では正当な編集を弾く / 誤った世帯で事前認可してしまう。
  なお `/onboarding` は**世帯未所属で走るのが正常**なので世帯チェックを課さない
  （`create_own_household` が SECURITY DEFINER 側で所属ゼロを強制）。
- **Service Worker（`public/sw.js`）は Supabase の API レスポンスや署名付き写真 URL
  （private / 期限付き）をキャッシュしない**。キャッシュ戦略を変えるときはこの不変条件を守る。
- 入力由来の値（ファイル名等）はサニタイズする（`buildStoragePath` 参照）。

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
