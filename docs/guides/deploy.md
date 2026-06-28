# デプロイ・リリース手順

mfmf は **GitHub Actions から Vercel CLI で明示的にデプロイ**します。
「いつ・どこへ出すか」を Actions に一本化するため、Vercel の Git 連携自動デプロイは
`vercel.json` の `git.deploymentEnabled: false` で無効化しています
（この方針の背景は [explanation/design-decisions.md](../explanation/design-decisions.md#デプロイ方針)）。

## フロー

| トリガ | デプロイ先 | DB マイグレーション | ワークフロー |
| --- | --- | --- | --- |
| PR | （CI のみ：lint / typecheck / build） | なし | `.github/workflows/ci.yml` |
| main へマージ(push) | Vercel **Preview** | `supabase db push`（preview env） | `.github/workflows/deploy-preview.yml` |
| タグ付き Release 公開 | Vercel **Production** | `supabase db push`（production env、保険） | `.github/workflows/deploy-production.yml` |

- **main は Preview 止まり**。マージしただけでは本番（Vercel Production）に出ません。
- **本番反映は Release 公開がトリガ**。どちらも CI（`ci.yml` を `workflow_call` で再利用）が
  緑のときだけデプロイされます。
- **DB スキーマは main マージ時点で本番 Supabase に進む**（preview と production が同一 Supabase プロジェクトを共有するため）。`supabase db push` は冪等なので、Release 時の再実行は no-op です。
- 各ジョブ順は `verify → check-secrets → migrate → deploy`。`migrate` が失敗したら `deploy` は走りません。

## 本番（Production）へ出す手順

1. main に出したい変更がマージ済みであることを確認する。
2. GitHub の **Releases > Draft a new release** で、main の HEAD（または対象 commit）に
   タグ（例: `v1.2.0`）を作成する。
3. **Generate release notes** でリリースノートを生成し、**Publish release**。
4. `deploy-production.yml` が起動し、CI 緑のあと Vercel Production へデプロイされる。

> ロールバックは Vercel ダッシュボードの過去デプロイから即時可能。

## 初回セットアップ（1回だけ）

### 1. Vercel プロジェクト ID を取得

```bash
npx vercel link            # 対象の Vercel プロジェクトを選択
cat .vercel/project.json   # orgId / projectId を確認
```

`.vercel/` は `.gitignore` 済み（コミットしない）。

### 2. Vercel トークンを発行

Vercel ダッシュボード > **Account Settings > Tokens** で発行する。

### 3. GitHub Secrets を登録

リポジトリの **Settings > Secrets and variables > Actions** に以下を登録する。
本番を保護したい場合は **Settings > Environments** で `preview` / `production` を作り、
Secrets をその Environment スコープに置く（`production` に承認ルールを付けると誤発射を防げる）。

| Secret | 用途 | 取得元 |
| --- | --- | --- |
| `VERCEL_TOKEN` | Vercel デプロイ | Vercel Account Settings > Tokens |
| `VERCEL_ORG_ID` | Vercel デプロイ | `.vercel/project.json` の `orgId` |
| `VERCEL_PROJECT_ID` | Vercel デプロイ | `.vercel/project.json` の `projectId` |
| `SUPABASE_ACCESS_TOKEN` | Supabase migrate | Supabase Dashboard > Account > [Access Tokens](https://supabase.com/dashboard/account/tokens) で発行 |
| `SUPABASE_DB_PASSWORD` | Supabase migrate | Supabase Dashboard > 対象プロジェクト > Project Settings > Database |
| `SUPABASE_PROJECT_ID` | Supabase migrate | Project URL の subdomain（例: `abcdefghijklmnopqrst.supabase.co` の左側 20 文字） |

Supabase 系 3 つを **preview / production 両 Environment** に登録する（同一プロジェクト共有のため値は同じ）。
未設定の場合は `migrate` ジョブが自動 skip され、Vercel deploy は続行される（DB に触れない状態で動作確認したいときの抜け道）。

### 4. Vercel 側の環境変数

`NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` を Vercel の
**Settings > Environment Variables** に **Preview / Production それぞれ**設定する。
`vercel pull --environment=preview|production` がこれらを取得してビルドに使う
（GitHub Actions の CI ビルドはプレースホルダ値で通すだけで、実値は Vercel から取得する）。
変数の一覧は [reference/configuration.md](../reference/configuration.md) を参照。

## Supabase（DB）マイグレーション

`supabase/migrations/` の SQL は **GitHub Actions の `migrate` ジョブで自動適用**される
（`supabase/setup-cli` → `supabase link` → `supabase db push` の 3 ステップ）。

- **main マージ時**：`deploy-preview.yml` の `migrate` が走り、未適用分を本番 Supabase に push する。
- **Release 公開時**：`deploy-production.yml` の `migrate` がタグ時点の `supabase/migrations/` を再 push する（冪等で実質 no-op）。
- preview と production は **同一 Supabase プロジェクトを共有**するため、main マージ時点でスキーマが本番 DB に進む点に注意。

### 新しい migration を足すときの手順

1. ローカルで `supabase migration new <name>` → 生成された SQL を編集。
2. ローカル Supabase で動作確認：`supabase db reset`（既存データは消える）。
3. PR を出して CI（lint / typecheck / build）を緑にする。
4. main マージ → `deploy-preview.yml` が `migrate` → `deploy` の順で動く。
5. preview 環境で動作確認 → Release タグ公開で本番反映。

### 破壊的変更（DROP / カラム削除 / 型変更）の運用

preview と production が DB を共有しているため、destructive 変更は **main マージ時点で本番 DB に作用する**。
事故を避けるため、以下を守る：

- PR レビュー時に migration ファイルを必ず目視確認する。
- ローカルで `supabase db reset` → アプリの主要画面を一通り操作してから main にマージする。
- 「main マージ → 本番 DB が古いコードに見られて RLS / 型不一致で落ちる」期間が短くなるよう、PR は小さく刻む。
- destructive な SQL（`DROP TABLE` / `DROP COLUMN` / `ALTER COLUMN ... TYPE` / `TRUNCATE` / `DELETE FROM`）を含む PR は `check-destructive-migration` ジョブが GitHub の Warning アノテーションを出す。Warning が出た PR は **マージ前に Artifact からの復旧可否を確認**する。

### 失敗・誤適用からの復旧

**Free プランには自動バックアップも PITR も無い。** ロールバック手段は以下のいずれか：

#### 1. GitHub Actions Artifact からの復元（推奨・標準手段）

`migrate` ジョブは `supabase db push` の**前に** `supabase db dump` で本番 DB の schema と data を取り、Artifact として 90 日間保持する。
名前は preview / production で分かれている：

- preview（main マージ時）: `supabase-backup-preview-<commit-sha>`
- production（Release 公開時）: `supabase-backup-production-<release-tag>`

> ⚠️ **dump 対象は `public` スキーマのみ**。`auth.users`（Supabase Auth 管理）/ `storage.*`（Storage メタデータ）/ Storage バケット本体（`record_photos` の画像ファイル）は含まれない。
> - `auth.users` は通常 Supabase Auth 側に残るが、Auth まで壊した場合は別途 `supabase auth export` で個別退避が必要。
> - `record_photos` の画像本体は Storage バケットにあり、DB 復元しても画像は戻らない。Storage 自体の事故からの復旧手段は Free プランでは無い（rclone 等での日常的な同期が唯一の自衛策）。

復元手順（ローカルから）：

```bash
# 1. GitHub の該当 Actions run（Actions タブ → 対象 workflow → 該当 run）から
#    Artifact "supabase-backup-<sha>" をダウンロードして展開する。
#    pre-migrate-schema.sql / pre-migrate-data.sql が得られる。

# 2. Supabase Dashboard → Project Settings → Database → Connection string
#    から direct connection の URL（postgres://postgres:<PW>@db.<ref>.supabase.co:5432/postgres）を取得。

# 3. （スキーマも巻き戻す場合）まず該当の migration を取り消す or DB を一度クリアする。
#    安全な順は：
#    - 影響テーブルの行を `DELETE FROM` して空に
#    - 破壊された migration の逆方向 SQL を手で書いて適用、または `supabase migration repair --status reverted <version>` で履歴のみ修復
#    - dump からテーブル定義を `psql "$DATABASE_URL" -f pre-migrate-schema.sql` で再構築（既存テーブルは CREATE で失敗するので必要な部分だけ抜粋）

# 4. データだけ戻すなら：
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f pre-migrate-data.sql
```

> ⚠️ 復元中はアプリが整合しない状態になる。Vercel Dashboard で過去デプロイに一時的にロールバックしておくか、メンテモードを掲示する。

#### 2. 緊急時の Pro プラン一時アップグレード（裏技）

- Supabase Dashboard → Settings → Subscription Plan → Pro へアップグレード（$25/月）。
- アップグレード直後から **過去 7 日分の日次バックアップが Dashboard から復元可能**になる（コミュニティ確認済み挙動）。
- 復元完了後にダウングレードして Free に戻せる。

`supabase_migrations.schema_migrations` の履歴を直接いじる場合は `supabase migration repair --status applied|reverted <version>` を使う。

#### 3. Storage（写真）の破損

**DB backup には Storage は含まれない。** `record_photos` バケットを誤って空にした場合、Free プランでは復旧手段なし。
日常的に `record_photos` を rclone / `supabase storage cp` で別ストレージへ同期しておくのが唯一の自衛策（cron 自動化は別タスク）。

### `supabase db push` 自体が失敗した時

- 単一 migration ファイル内なら CLI が暗黙にトランザクションで包むため、エラー時は**そのファイル全体がロールバック**される（`schema_migrations` にも残らない）。
- 複数 migration があり N 個目で失敗した場合、N-1 個目までは適用済み。SQL を直して **同じ commit を re-run** すれば N 個目から再開される（冪等）。
- 明示的に `COMMIT;` を書いた DDL を含めると部分適用が残り `supabase migration repair --status applied <version>` で履歴修復が必要になる。原則 migration ファイル内で明示 COMMIT を書かないこと。

## 補足: リリースノートの自動化

「タグ付け + リリースノート作成」を自動化したい場合は、Conventional Commits をベースに
**release-please** や **Changesets** を導入し、「バージョン上げ PR → マージで自動タグ + Release 公開」に
できる。まずは手動 Release で運用し、頻度が上がったら検討する。
