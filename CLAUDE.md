# CLAUDE.md

このファイルは Claude Code が **mfmf**（ペット保育園記録アプリ）で作業するための指針です。
全体像は `README.md`。本番のDB/RLSは `db/gcp/` のbaseline・追加migration・検証契約、
Supabase互換の元スキーマとローカル開発は `supabase/migrations/` 全体を正とします。
ツール非依存の要点版は `AGENTS.md`、各種手順・仕様は `docs/`（索引は `docs/README.md`）にあります。

## プロジェクト概要

家族で保育園の日々の記録（テキスト＋写真）を残す最小構成の PWA。

- 本番配信: **Next.js 15（App Router）+ React 19 + TypeScript（strict）+ Tailwind CSS v4** / Cloud Run
- 本番認証/DB/画像: **Identity Platform / Cloud SQL PostgreSQL 17 / Cloud Storage**。
  本番はGCPモード、ローカル開発と既存テストにはSupabaseモードを残します。
  切替受入と通常配信の証跡は [GCP移行記録](docs/explanation/gcp-migration.md#現在の実装と切替記録)を参照。
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
| Integration テスト（Vitest + 実 Supabase / `tests/integration/`。要ローカル Supabase） | `npm run test:integration` |
| E2E + VRT（Playwright / `tests/e2e/`。要ローカル Supabase + build） | `npm run test:e2e` |
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
- **データ変更は Server Action**（`src/app/(app)/records/actions.ts`）で行い、`redirect` / `revalidatePath` で反映。
  認証・画像アップロードの専用Route Handlerは各モジュールの境界を維持する。
- **既存クライアント入口を用途別に使う**。`supabase`という名前だけで接続先を判断しない:
  - Server Component / Server Action / Route Handler: `src/lib/supabase/server.ts`。GCPモードでは
    Identity Platform検証済みidentityを `src/lib/gcp/dataClient.ts` のloopback PostgRESTへ渡す。
    `supabase-js` はクエリビルダとして残し、外部Supabase Auth/Storageへfallbackしない。
  - セッション更新: `src/lib/supabase/middleware.ts` / `src/middleware.ts`。
    GCP認証のCookie・失効・CSRF契約は `src/lib/identity/` が管理する。
  - `src/lib/supabase/client.ts` はSupabaseモード専用。GCPモードのブラウザDBアクセスは禁止。
- Server Action 冒頭の `supabase.auth.getUser()` と操作別認可は両モードで維持し、
  未ログインは `redirect("/login")`。ブラウザのUID・roleを信頼しない。
- パスエイリアスは `@/*` → `src/*`。
- 型は `src/types/database.ts`。Storage バケット名は定数 `PHOTO_BUCKET`。
- 画像は送信前にブラウザで長辺 1600px へ縮小・JPEG 再圧縮（`src/lib/imageResize.ts`）。
- **画像本体はブラウザから非公開Storageへ直接アップロード**する（`RecordForm` / `AvatarUploader`）。
  Server Actionには予約IDまたは従来のオブジェクトパスだけを送り、本体のサイズ上限を避ける。
  保存先の正はDBの`get_media_storage_mode()`。GCSでは認可済み予約のincomingだけに署名PUTし、
  サーバーが実画像・世代を検証してimmutable finalへコピーする。詳細は
  [media-storage-ledger.md](docs/reference/media-storage-ledger.md)。切替後はSupabaseへfallbackしない。
- 以下はSupabaseモードのStorageパス規約。GCSの予約・世代・bindingは画像台帳の契約を使う。
  Storage オブジェクトパス規約: `{household_id}/{record_id}/{filename}`。生成/検証は
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
- **その機能が PWA の限界に触れるなら、実装に入る前にそう言うこと。** アプリ化は D35 で
  「今はしない」と決めただけで、永久に却下したのではない。**判定条件は
  [mobile-app-tech-selection.md §5-3](./docs/explanation/mobile-app-tech-selection.md#5-3-方針を覆す条件これが起きたら-c-へ)**
  （通知の取りこぼし / 他アプリの共有シートから mfmf へ送る経路 / Apple の PWA サポート後退）。
  **通知は「届かなかった」だけでは該当しない** —— 許可の取り消し・購読の期限切れ・送信側や VAPID の
  不具合・端末オフラインが原因なら、ネイティブへ移っても直らない。**iOS の Web Push 側の制約で、
  かつネイティブ push なら解決すると切り分けられたときだけ**トリガーとして扱う。
  該当したら黙って web で迂回実装せず、**Capacitor 案（C）の再検討を提案する**。
  ただし**写真の撮影・選択はトリガーではない** —— `RecordForm` の
  `<input type="file" accept="image/*">` でモバイルのカメラは既に開ける
- **新しい Server Action を足すときは「そのまま Edge Function へ移せる形か」を意識する**（上の再検討が
  来たときの移行コストが下がる）。**アプリ層の認可を省いてよいという意味ではない** ——
  冒頭の `getUser()` と操作別の世帯 / role チェックは下の「セキュリティ（厳守）」のとおり必須で、
  移行先が Edge Function でも**同じ判定を関数側に持っていく**（D35 §4-3）

## セキュリティ（厳守）

- **秘密情報をコミット/出力しない。** `.env.local` 等の実 env ファイルは読まない・編集しない
  （ガードフックがブロック）。設定例は `.env.local.example` を参照。
- `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` はブラウザ公開される前提の値。
  一方 **service_role key はクライアント・リポジトリに絶対に置かない**（このアプリでは使わない）。
- **セキュリティの一次防衛線は PostgreSQL の RLS**。GCPモードでも非昇格runtime roleを使い、
  判定は**世帯メンバーシップと role**
  （`has_household_role` / `is_household_member`）＋ ゲストは `guest_grants` の対象/期間。
  一部の経路で `owner_id = auth.uid()` が併存する（世帯未所属時のフォールバック等）。
  テーブル/ポリシーを変える migration を書くときは既存の RLS を弱めないこと。
  テナント分離は `supabase/tests/` のpgTAPに加え、`tests/gcp/` の実PostgreSQL・PostgREST・operator検証で守る。
- **Server Action は冒頭で必ず `getUser()`。認可はそのうえで「操作に応じたもの」を使う**
  （ひとつのヘルパーで代用しない）。**どのヘルパーがどの操作用かは
  [`src/lib/household.ts`](src/lib/household.ts) と各 `actions.ts` を読むこと** ——
  ここに対応表を持つとコードと二重管理になり、実際にこの表は 2 度間違えた（D16）。
  取り違えやすい 1 点だけ書いておく: **更新 / 削除は「現在世帯」ではなく「対象行の
  `household_id`」で判定する。** 複数世帯に属するユーザーが別タブで世帯を切り替えていると、
  現在世帯基準では正当な編集を弾く / 誤った世帯で事前認可してしまう。
  なお `/onboarding` は**世帯未所属で走るのが正常**なので世帯チェックを課さない
  （`create_own_household` が SECURITY DEFINER 側で所属ゼロを強制）。
- **Service Worker（`public/sw.js`）は認証済み API レスポンスや署名付き写真 URL
  （private / 期限付き）をキャッシュしない**。キャッシュ戦略を変えるときはこの不変条件を守る。
- 入力由来の値（ファイル名等）はサニタイズする（`buildStoragePath` 参照）。

## Git / PR

- 作業ブランチで開発し、`git push -u origin <branch>` でプッシュ。`main` へ直接 push しない。
- 強制 push（`--force` / `-f`）は禁止（ガードでブロック）。
- PR は lint / typecheck / build の CI（`.github/workflows/ci.yml`）を通す。
- **UI に変更が入る PR には、変更後のスクリーンショットを必ず貼る**（どの画面がどう変わるかを
  レビュアーが差分コードなしで判断できるように）。キャプチャは CI の E2E が生成する
  `tests/e2e/zz-screenshots.spec.ts` の出力を、CI 成功後に `screenshots.yml`
  （`workflow_run`）が `screenshots/<headブランチ>` ブランチへ自動コミットするので、
  そのコミット SHA の raw URL で PR 本文/コメントから参照する（PR ブランチ自体には
  積まない。head がチェックなしのコミットになるため）。
  失敗時の一次情報は `playwright-report` アーティファクト。
  **`ci.yml` に `contents: write` 等の昇格権限を足さないこと** —— `ci.yml` は
  `deploy-production.yml` から `workflow_call` で再利用されており、呼び出し側
  （`contents: read`）より強い権限を要求すると main への push で run が起動できず
  本番デプロイが止まる。書き込みが要るものは別ワークフローに分ける。

## DB スキーマ変更

`supabase/migrations/` は互換元・ローカル開発の連番履歴として残す。新規はタイムスタンプ付きSQLを追加し、
既存の `20260616130704_init.sql` は編集しない。RLS・認可関数・`search_path` 固定を弱めない。
GCPへの対応は [db/gcp/README.md](db/gcp/README.md) のbaseline生成・source manifest・checksum契約に従う。
元migrationだけ変更して本番への対応を省略すると、GCPの検証と通常配信は停止する。

本番は `GCP_AUTH_ENABLED=true`。mainへのpushは全CI後、同じSHAのoperator imageで固定Jobの `upgrade` を実行し、
成功時だけCloud Runをstage/probe/promoteする。Supabaseの `db push` とVercel配信はskipする。
通常配信は初回import・freeze解除・認証モード変更を行わない。
追加SQLは `db/gcp/migrations/` に置き、既適用checksum・順序・旧revisionとの互換性を検証する。
**未適用SQLは直前backupと、30時間以内の成功した日次保持receipt・実装hash・固定instanceの一致を必須とする。**
StandardのNULL expiryを単独で許可しない。通常配信は先に同じimage/SHAの既存2バックアップJobを検証する。
[日次保全・保持契約](docs/guides/gcp-backup-automation.md)の初期実受入、失敗時の停止、独立した復号鍵を維持する。

破壊的変更はPR段階でローカルSupabaseと隔離GCP DBの復元・認可検証を行う。
appのtrafficを戻してもDB・IdPは戻らない。旧Supabaseは凍結保全し、通常配信から更新・自動解除しない。
詳細は [通常配信](docs/guides/gcp-database-deployment.md) と [デプロイ手順](docs/guides/deploy.md)。
