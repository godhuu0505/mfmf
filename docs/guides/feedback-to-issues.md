# ご意見・不具合フォームの Issue 化（運用）

公開リポジトリに内容が漏れないよう、アプリは **GitHub に何も送らず**、送信内容は Supabase の
`feedback` テーブル（非公開・RLS 保護）にのみ保存します。GitHub Issue 化が必要になったら、
個人情報・秘匿情報をマスクしたうえで **非公開(private)リポジトリ宛て**に転記するスクリプトを
手元で実行します（`scripts/feedback-to-issues.mjs`）。背景は
[explanation/design-decisions.md](../explanation/design-decisions.md#フィードバックを-github-に送らない理由) を参照。

## 手順

```bash
# 1. .env.local に以下を設定（.env.local.example 参照）
#    FEEDBACK_USER_EMAIL / FEEDBACK_USER_PASSWORD … 夫婦共用ログイン（RLS 経由で取得）
#    GITHUB_TOKEN … Issues 書き込み権の Fine-grained PAT
#    GITHUB_FEEDBACK_REPO … 登録先 owner/repo（★ 必ず非公開リポジトリ）

# 2. まずマスク結果を目視確認（GitHub には登録しない）
node --env-file=.env.local scripts/feedback-to-issues.mjs --dry-run

# 3. 問題なければ登録（登録済みは github_issue_number で重複登録を防止）
node --env-file=.env.local scripts/feedback-to-issues.mjs
```

`npm run feedback:issues` でも同じスクリプトを起動できます（env の読み込みは別途必要）。

## 注意

- メール・電話番号・トークン / API キー・URL のクエリ等は**自動でマスク**しますが、
  名前など一般語は自動検出できません。**必ず `--dry-run` で内容を確認してから**登録してください。
- 登録先は **必ず非公開リポジトリ**にしてください（`GITHUB_FEEDBACK_REPO`）。
