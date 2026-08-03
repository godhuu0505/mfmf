# ご意見・不具合フォームの Issue 化（運用）

公開リポジトリに内容が漏れないよう、アプリは **GitHub に何も送らず**、送信内容は Supabase の
`feedback` テーブル（非公開・RLS 保護）にのみ保存します。GitHub Issue 化が必要になったら、
個人情報・秘匿情報をマスクしたうえで **非公開(private)リポジトリ宛て**に転記するスクリプトを
手元で実行します（`scripts/feedback-to-issues.mjs`）。背景は
[explanation/decisions.md](../explanation/decisions.md) の D21 を参照。

## 手順

```bash
# 1. .env.local に以下を設定（.env.local.example 参照）
#    FEEDBACK_USER_EMAIL / FEEDBACK_USER_PASSWORD … 取得用アカウント（RLS 経由で読む）。
#      ★ このアカウントが見えるすべての世帯で owner か editor であること。
#        スクリプトは Issue 作成後に feedback 行へ github_issue_number 等を書き戻すが、
#        RLS の feedback_update_member が owner/editor を要求するため、
#        viewer の世帯の行は更新だけ失敗し、毎回 Issue が作り直される（下記）
#    GITHUB_TOKEN … Issues 書き込み権の Fine-grained PAT
#    GITHUB_FEEDBACK_REPO … 登録先 owner/repo（★ 必ず非公開リポジトリ）

# 2. まずマスク結果を目視確認（GitHub には登録しない）
node --env-file=.env.local scripts/feedback-to-issues.mjs --dry-run

# 3. 問題なければ登録（登録済みは github_issue_number で重複登録を防止）
node --env-file=.env.local scripts/feedback-to-issues.mjs
```

`npm run feedback:issues` でも同じスクリプトを起動できます（env の読み込みは別途必要）。

## 注意

- ⚠️ **取得用アカウントは「viewer で参加している世帯」を持たないこと。**
  スクリプトの取得は `feedback.select("*")` で**世帯で絞っていません**
  （`scripts/feedback-to-issues.mjs:201-205`）。読み取り側の RLS
  `feedback_select_member` は `has_household_role(household_id)` を**ロール指定なしで**
  呼ぶので、**viewer で参加している世帯の行も読めます**。
  一方 Issue 作成後の書き戻しは `feedback_update_member` が owner/editor を要求するため、
  その世帯の行だけ更新が失敗して `github_issue_number` が null のまま残り、
  **次回実行で同じ内容の Issue がもう一度作られます**（毎回増える）。
  複数世帯に属するアカウントを使うなら、**すべての世帯で owner / editor** にするか、
  この用途専用のアカウントを 1 世帯だけに参加させてください。
- メール・電話番号・トークン / API キー・URL のクエリ等は**自動でマスク**しますが、
  名前など一般語は自動検出できません。**必ず `--dry-run` で内容を確認してから**登録してください。
- 登録先は **必ず非公開リポジトリ**にしてください（`GITHUB_FEEDBACK_REPO`）。
