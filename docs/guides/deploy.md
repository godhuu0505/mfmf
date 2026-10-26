# デプロイ・リリース手順

mfmf は **GitHub Actions から Vercel CLI で明示的にデプロイ**します。
「いつ・どこへ出すか」を Actions に一本化するため、Vercel の Git 連携自動デプロイは
`vercel.json` の `git.deploymentEnabled: false` で無効化しています
（この方針の背景は [explanation/decisions.md](../explanation/decisions.md) の D22）。

## フロー

| トリガ | デプロイ先 | DB マイグレーション | ワークフロー |
| --- | --- | --- | --- |
| PR | （CI のみ：lint / typecheck / build） | なし | `.github/workflows/ci.yml` |
| main へマージ(push) | Vercel **Production** | `supabase db push`（production env） | `.github/workflows/deploy-production.yml` |

- **merge = 本番リリース**。main にマージした時点で migration 適用 → Vercel Production デプロイまで一気に走ります。
- CI（`ci.yml` を `workflow_call` で再利用）が緑のときだけデプロイされます。
- **DB スキーマも main マージ時点で本番 Supabase に進む**。`supabase db push` は冪等です。
- `verify` と `check-secrets` の後に `migrate → deploy` が続きます。`migrate` の失敗・skip 時は `deploy` も停止します。

## 本番（Production）へ出す手順

1. PR を出し、CI（lint / typecheck / build）を緑にする。
2. **main にマージするだけ**。`deploy-production.yml` が起動し、CI 緑のあと migration を本番に適用してから Vercel Production へデプロイされる。

> ロールバックは Vercel ダッシュボードの過去デプロイから即時可能。
> 本番への誤発射を防ぎたい場合は **Settings > Environments > `production`** に承認ルール（Required reviewers）を付ける。
>
> ⚠️ Required reviewers を付けると、`production` を参照する **各ジョブ（`check-secrets` / `migrate` / `deploy`）で個別に承認**を求められる。`migrate`（破壊的・スキーマ前進）を承認したら**続けて `deploy` も必ず承認**すること。`deploy` だけ遅延／拒否すると、本番 DB は新スキーマなのにアプリは旧デプロイのまま、という不整合状態が続く。その場合は**同じ commit を re-run** すれば `migrate`（冪等で no-op）→ `deploy` の順で復旧できる。

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
本番を保護したい場合は **Settings > Environments** で `production` を作り、
Secrets をその Environment スコープに置く（`production` に承認ルールを付けると誤発射を防げる）。

| Secret | 用途 | 取得元 |
| --- | --- | --- |
| `VERCEL_TOKEN` | Vercel デプロイ | Vercel Account Settings > Tokens |
| `VERCEL_ORG_ID` | Vercel デプロイ | `.vercel/project.json` の `orgId` |
| `VERCEL_PROJECT_ID` | Vercel デプロイ | `.vercel/project.json` の `projectId` |
| `SUPABASE_ACCESS_TOKEN` | Supabase migrate | Supabase Dashboard > Account > [Access Tokens](https://supabase.com/dashboard/account/tokens) で発行 |
| `SUPABASE_DB_PASSWORD` | Supabase migrate | Supabase Dashboard > 対象プロジェクト > Project Settings > Database |
| `SUPABASE_PROJECT_ID` | Supabase migrate | Project URL の subdomain（例: `abcdefghijklmnopqrst.supabase.co` の左側 20 文字） |

Supabase 系 3 つを **`production` Environment** に登録する。
未設定の場合は `migrate` と Vercel deploy が停止します。古い DB に新しいコードだけを出すことは許可しません。

### 4. バックアップの公開鍵を登録

公開リポジトリの Actions Artifact はリポジトリ閲覧者も取得できます。**平文の本番 DB を保存しないでください。**
管理者の端末に `age` を導入し、リポジトリ外の保護された場所で鍵を作ります。

```bash
umask 077
mkdir -p "$HOME/.local/share/mfmf-backups"
age-keygen -o "$HOME/.local/share/mfmf-backups/identity.txt"
age-keygen -y "$HOME/.local/share/mfmf-backups/identity.txt" > "$HOME/.local/share/mfmf-backups/recipient.txt"
gh variable set SUPABASE_BACKUP_AGE_RECIPIENT --repo godhuu0505/mfmf < "$HOME/.local/share/mfmf-backups/recipient.txt"
```

GitHub に登録するのは **公開鍵だけ**です。`identity.txt` は復号に必須の秘密鍵なので、
コミット・Artifact・ログ・GitHub Secrets へ入れず、別の安全な保管先にも控えを置いてください。
鍵を紛失すると過去のバックアップは復元できません。鍵を替えた後も、旧バックアップの保持期間中は旧鍵が必要です。
公開鍵未設定・不正値・dump失敗・暗号化失敗は、migration より前に処理を停止します。

### 5. Vercel 側の環境変数

`NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` を Vercel の
**Settings > Environment Variables** の **Production** に設定する。
`vercel pull --environment=production` がこれらを取得してビルドに使う
（GitHub Actions の CI ビルドはプレースホルダ値で通すだけで、実値は Vercel から取得する）。
変数の一覧は [reference/configuration.md](../reference/configuration.md) を参照。

## Supabase（DB）マイグレーション

`supabase/migrations/` の SQL は **GitHub Actions の `migrate` ジョブで自動適用**される
（`supabase/setup-cli` → `supabase link` → `supabase db push` の 3 ステップ）。

- **main マージ時**：`deploy-production.yml` の `migrate` が走り、未適用分を本番 Supabase に push してから Vercel Production deploy が続く。
- main マージ時点でスキーマが本番 DB に進む点に注意（破壊的変更は下記参照）。

### 新しい migration を足すときの手順

1. ローカルで `supabase migration new <name>` → 生成された SQL を編集。
2. ローカル Supabase で動作確認：`supabase db reset`（既存データは消える）。
3. PR を出して CI（lint / typecheck / build）を緑にする。
4. main マージ → `deploy-production.yml` が `migrate` → `deploy` の順で動き、本番反映される。

### 破壊的変更（DROP / カラム削除 / 型変更）の運用

main マージ = 本番反映のため、destructive 変更は **main マージ時点で本番 DB に作用する**。
事故を避けるため、以下を守る：

- PR レビュー時に migration ファイルを必ず目視確認する。
- ローカルで `supabase db reset` → アプリの主要画面を一通り操作してから main にマージする。
- 「main マージ → 本番 DB が古いコードに見られて RLS / 型不一致で落ちる」期間が短くなるよう、PR は小さく刻む。
- destructive な SQL（`DROP TABLE` / `DROP COLUMN` / `ALTER COLUMN ... TYPE` / `TRUNCATE` / `DELETE FROM`）を含む PR は `check-destructive-migration` ジョブが GitHub の Warning アノテーションを出す。Warning が出た PR は **マージ前に Artifact からの復旧可否を確認**する。

### 失敗・誤適用からの復旧

**Free プランには自動バックアップも PITR も無い。** ロールバック手段は以下のいずれか：

#### 1. 暗号化済み GitHub Actions Artifact からの復元

`migrate` ジョブは `supabase db push` の**前に**本番 DB の schema と data を取り、
`scripts/backup-db.sh` で age 暗号化した `.sql.age` だけを Artifact として90日間保持します。
名前は `supabase-backup-production-encrypted-<commit-sha>`（main マージの commit SHA）。
平文は権限を絞った一時ディレクトリにのみ作り、正常時・異常時とも削除します。
これはマージ直前の退避であり、定期バックアップや写真のバックアップではありません。

> ⚠️ **dump 対象は `public` スキーマのみ**。`auth.users`（Supabase Auth 管理）/ `storage.*`（Storage メタデータ）/ Storage バケット本体（`record_photos` の画像ファイル）は含まれない。
> - `auth.users` は通常 Supabase Auth 側に残るが、Auth まで壊した場合は別途 `supabase auth export` で個別退避が必要。
> - `record_photos` の画像本体は Storage バケットにあり、DB 復元しても画像は戻らない。Storage 自体の事故からの復旧手段は Free プランでは無い（rclone 等での日常的な同期が唯一の自衛策）。

復元手順（ローカルから）：

```bash
# 1. GitHub の該当 Actions run（Actions タブ → 対象 workflow → 該当 run）から
#    Artifact "supabase-backup-production-encrypted-<sha>" をダウンロードして展開する。
#    リポジトリ外の保護されたディレクトリで復号する。SQL を画面へ出力しない。
umask 077
age --decrypt --identity "$HOME/.local/share/mfmf-backups/identity.txt" \
  --output pre-migrate-schema.sql pre-migrate-schema.sql.age
age --decrypt --identity "$HOME/.local/share/mfmf-backups/identity.txt" \
  --output pre-migrate-data.sql pre-migrate-data.sql.age

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

旧形式の平文 Artifact が残っている場合は、内容を出力せず暗号化して保護された場所へ退避し、
復号後のハッシュ一致を確認してから公開 Artifact を削除します。保持期限まで放置しないでください。

#### 2. Supabase が保持しているバックアップからの復元

有料プランの日次バックアップや PITR を利用している場合は、Dashboard で復元可能な時点を確認します。
**事故後のアップグレードで、Free 利用中の過去データが復元できるとは保証されません。**
事前に確保したバックアップを基準にしてください。対象・保持期間は
[Supabase 公式のバックアップ手順](https://supabase.com/docs/guides/platform/backups)を参照します。

`supabase_migrations.schema_migrations` の履歴を直接いじる場合は `supabase migration repair --status applied|reverted <version>` を使う。

#### 3. Storage（写真）の破損

**DB backup には Storage は含まれない。** `record_photos` バケットを誤って空にした場合、Free プランでは復旧手段なし。
日常的に `record_photos` を rclone / `supabase storage cp` で別ストレージへ同期しておくのが唯一の自衛策（cron 自動化は別タスク）。

### `supabase db push` 自体が失敗した時

- 単一 migration ファイル内なら CLI が暗黙にトランザクションで包むため、エラー時は**そのファイル全体がロールバック**される（`schema_migrations` にも残らない）。
- 複数 migration があり N 個目で失敗した場合、N-1 個目までは適用済み。SQL を直して **同じ commit を re-run** すれば N 個目から再開される（冪等）。
- 明示的に `COMMIT;` を書いた DDL を含めると部分適用が残り `supabase migration repair --status applied <version>` で履歴修復が必要になる。原則 migration ファイル内で明示 COMMIT を書かないこと。

### `supabase link` が `project is paused` で失敗した時

Free プランは低利用が続くと一時停止されます。この場合は migration 前に止まり、
Vercel Production も実行されません。既存プロジェクトの復帰には
**Actions → Resume Supabase Production → Run workflow（main）** を使います。
`workflow_dispatch` 専用で、production Environment の既存
`SUPABASE_ACCESS_TOKEN` / `SUPABASE_PROJECT_ID` を使います。DB password は不要です。

1. Management API で対象プロジェクトの状態を確認する。
2. 停止状態 `INACTIVE` のときだけ `POST /v1/projects/{ref}/restore` を一度送る。
   既に `ACTIVE_HEALTHY` / `RESTORING` / `COMING_UP` なら POST せず健康確認へ進む。
   それ以外の初期状態は停止し、Dashboard で原因を確認する。
3. 最大20分、プロジェクトと `db` / `auth` / `rest` / `storage` がすべて
   `ACTIVE_HEALTHY` になるまで待つ。API エラー・失敗状態・タイムアウトはジョブを失敗させる。
4. 成功後に、反映したい commit の **Deploy Production** run を確認して手動で再実行する。
   バックアップ → migration → deploy の既存ゲートを通す。

復帰 workflow は SQL・migration・Vercel deploy を実行せず、API 応答本文・token・接続情報も
ログへ出しません。通常の本番デプロイと同じ concurrency group で直列化します。
復帰要求の通信結果が不明でも自動再送しません。Dashboard の状態を確認してから再実行してください。

[公式の停止・復帰仕様](https://supabase.com/docs/guides/platform/free-project-pausing)では
停止後1年以内が復帰可能期間です（2026-10-27確認）。プロジェクト個別の復帰可否や token の権限は
API が判定します。権限不足・期間超過等で拒否された場合は Dashboard / Supabase サポートで確認し、
別プロジェクトへの復元やアップグレードをこの workflow で自動実行することはありません。
API 仕様: [状態取得](https://supabase.com/docs/reference/api/v1-get-project) /
[復帰](https://supabase.com/docs/reference/api/v1-restore-a-project) /
[サービス健康確認](https://supabase.com/docs/reference/api/v1-get-services-health)。

## 補足: リリースノート / バージョニング

本番デプロイは main マージで自動化されているため、GitHub Release はデプロイのトリガではなく
**変更履歴の記録用途**になる。タグ付け + リリースノートを残したくなったら、Conventional Commits を
ベースに **release-please** や **Changesets** を導入し「バージョン上げ PR → マージで自動タグ + Release
公開（ノート生成のみ、デプロイには非連動）」にできる。まずは無しで運用し、必要になったら検討する。
