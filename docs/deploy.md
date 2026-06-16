# デプロイ / CI・CD

mfmf のデプロイは **GitHub Actions から Vercel CLI で明示的にデプロイ**します。
Vercel の Git 連携による自動デプロイは `vercel.json` の `git.deploymentEnabled: false` で無効化し、
「いつ・どこへ出すか」を Actions に一本化しています。

## フロー

```
PR                  → CI（lint / typecheck / build）          … ci.yml
main へマージ(push)  → CI 緑 → Vercel Preview へデプロイ        … deploy-preview.yml
タグ付き Release 公開 → CI 緑 → Vercel Production へデプロイ     … deploy-production.yml
```

- **main は Preview 止まり**。マージしただけでは本番に出ません。
- **本番反映は Release 公開がトリガ**。main に入っている commit にタグを付け、その
  Release（Release Note 作成）を公開した時だけ Production にデプロイされます。
- どちらも先に CI（`ci.yml` を `workflow_call` で再利用）が緑になることが条件です。

## 本番（Production）へ出す手順

1. main に出したい変更がマージ済みであることを確認する。
2. GitHub の **Releases > Draft a new release** で、main の HEAD（または対象 commit）に
   タグ（例: `v1.2.0`）を作成する。
3. **Generate release notes** でリリースノートを生成し、**Publish release**。
4. `deploy-production.yml` が起動し、CI 緑のあと Vercel Production へデプロイされる。

> ロールバックは Vercel ダッシュボードの過去デプロイから即時可能。

## 初回セットアップ（1回だけ）

### 1. Vercel プロジェクト ID を取得

ローカルでリポジトリを Vercel にリンクすると `.vercel/project.json` が生成される。

```bash
npx vercel link        # 対象の Vercel プロジェクトを選択
cat .vercel/project.json   # orgId / projectId を確認
```

`.vercel/` は `.gitignore` 済み（コミットしない）。

### 2. Vercel トークンを発行

Vercel ダッシュボード > **Account Settings > Tokens** で発行する。

### 3. GitHub Secrets を登録

リポジトリの **Settings > Secrets and variables > Actions** に以下を登録する。
本番を保護したい場合は **Settings > Environments** で `preview` / `production` を作り、
Secrets をその Environment スコープに置く（`production` に承認ルールを付けると誤発射を防げる）。

| Secret | 取得元 |
| --- | --- |
| `VERCEL_TOKEN` | Vercel Account Settings > Tokens |
| `VERCEL_ORG_ID` | `.vercel/project.json` の `orgId` |
| `VERCEL_PROJECT_ID` | `.vercel/project.json` の `projectId` |

### 4. Vercel 側の環境変数

`NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` を Vercel の
**Settings > Environment Variables** に **Preview / Production それぞれ**設定する。
`vercel pull --environment=preview|production` がこれらを取得してビルドに使う。
（GitHub Actions の CI ビルドはプレースホルダ値で通すだけで、実際の値は Vercel から取得する。）

## Supabase（DB）について

DB スキーマ（`supabase/migrations/`）は現状 SQL Editor での手動運用。RLS を壊すリスクを避けるため、
**アプリのデプロイ（このパイプライン）とは分離**し、当面は手動適用のままとする。
将来自動化する場合も `supabase db push` は本フローと独立したジョブにすること。

## 補足: リリースノートの自動化

「タグ付け + リリースノート作成」を自動化したい場合は、Conventional Commits をベースに
**release-please** や **Changesets** を導入し、「バージョン上げ PR → マージで自動タグ + Release 公開」に
できる。まずは手動 Release で運用し、頻度が上がったら検討する。
