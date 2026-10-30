# ご意見・不具合フォームの Issue 化（運用）

本番フィードバックは Cloud SQL の `feedback` に保存し、既存の Identity Platform 認証と RLS で保護します。
アプリから GitHub へ直接送信しません。必要なときだけ、**本人がログイン済みブラウザーで取得した分類情報**を
手元の `scripts/feedback-to-issues.mjs` からmfmf / mnmn / wkwk と今後のアプリで共用する固定の非公開リポジトリ
[`godhuu0505/app-operations`](https://github.com/godhuu0505/app-operations) へ転記します。
Issueタイトルの `[mfmf ...]` と参照markerの `mfmf-feedback:v1` でアプリ由来を区別します。
他アプリの転記を追加するときは、このnamespaceを流用せず専用のnamespaceを使います。
公開のアプリソースリポジトリ `godhuu0505/mfmf` は送信先として拒否します。背景は
[decisions.md](../explanation/decisions.md) の D21 を参照してください。

## 取得する情報と認可

本人のブラウザーで本番アプリにログインし、次の URL を開くと `mfmf-feedback.json` をダウンロードできます。

```text
https://mfmf-candidate-wspqvmhj6q-an.a.run.app/api/feedback/export
```

- GCP モード専用です。旧 Supabase への接続・フォールバックはありません。
- 既存 HttpOnly セッションをサーバーで検証してから、RLS と `owner_id = ログイン本人` の両方を適用します。
  世帯の owner/editor でも他人の報告をまとめて取得しません。viewer は本人の報告だけを取得できます。
- GitHub へ転記するのは、固定分類の種類・困り度・頻度・画面と日本時間の送信日だけです。
  自由記述、氏名、記入者、アカウント/世帯ID、元URL、クエリ、端末情報、詳細時刻は転記しません。
  参照はランダムな行IDの SHA-256 で、Issueには本人の `/feedback` 一覧への固定リンクを添えます。
- セッションCookie・IdPトークン・アプリのパスワードをコマンド、環境変数、ファイルへ持ち出しません。
  新しい GCP IAM 権限、DB ロール、RLS 例外は不要です。
- ダウンロードは `private, no-store`。JSON添付で返し、CORSは許可しません。
  既に旧方式で Issue 番号が記録済みの行は除外します。
- 最大100件です。`hasMore: true` の不完全な取得結果からの起票は拒否します。
  必要なら `?id=<本人の報告ID>` で1件に限定します。この場合も本人条件とRLSを維持します。

分類だけでは詳細を再現できません。投稿者は送信日・種類を手掛かりにアプリの自分の報告を確認し、
必要な情報だけを見直して非公開 Issue へ追記してください。自動的に名前などを完全検知できるという前提は置きません。
取得後に投稿を削除・変更した場合は、古いJSONを使わず再取得してください。

## dry-run → 非公開確認 → 明示実行

Node.js 22を使用します。以下のパスはダウンロードしたJSONへ置き換えます。
実 `.env` ファイルを読ませる必要はありません。

```bash
# 1. 既定はオフラインのdry-run。GitHub/GCPへ一切送信しない。
npm run feedback:issues -- --input=/absolute/path/mfmf-feedback.json

# 2. 以下2コマンドだけ GITHUB_TOKEN を秘密管理ツールからプロセスメモリへ設定する。
#    tokenを引数・履歴・ファイルへ書かない。--check は GET だけである。
npm run feedback:issues -- --check --input=/absolute/path/mfmf-feedback.json

# 3. dry-runのタイトル/本文/件数とsha256を確認した後、同じ計画を指定して実行する。
#    この操作は実際にIssueを作成し、GitHub側の通知を発生させ得る。
npm run feedback:issues -- --execute --input=/absolute/path/mfmf-feedback.json --approve-plan=<確認した64桁sha256>
```

GitHub の fine-grained PAT は **固定の `app-operations` リポジトリだけ**に限定します。
`--check` は Metadata read / Issues read、実行は Metadata read / Issues write が必要です。
Contents、Actions、Administration、GCP、Cloud SQL の権限は不要です。
`GITHUB_TOKEN` を利用後はプロセス環境から取り除いてください。
`FEEDBACK_USER_EMAIL` / `FEEDBACK_USER_PASSWORD` / `GITHUB_FEEDBACK_REPO` と旧Supabase設定は使用しません。

スクリプトは GitHub API で `private=true`、`visibility=private`、固定full_name、Issues有効、
archived/disabledでないことを実行時に確認します。IssueごとのPOST直前にも再確認し、途中でrepo IDが変われば停止します。
固定 `api.github.com` だけへ接続し、リダイレクトは拒否します。API本文・任意エラー・tokenは出力しません。

## 重複防止と失敗時

- Issue本文の固定参照markerを、open/closedを含む全Issue一覧で照合します。検索indexの反映待ちには依存しません。
  既存Issueがあれば状態にかかわらずskipし、同一markerが複数あれば停止します。PRは照合対象から外します。
- 初回POSTの**前**に `~/.local/state/mfmf-feedback/`（0700）へ作成意図をexclusive作成し、
  ファイル（0600）とディレクトリをfsyncします。成功記録は別ファイルです。`--state-dir=/absolute/private/path` で変更できますが、
  同じ運用では同じディレクトリを維持してください。
- POSTは1回だけです。通信切断、応答不明、成功応答の検証失敗、成功記録の保存失敗でも作成意図を残します。
  次回、既存Issueを見つければskipし、見つからなければexclusive記録が再POSTを止めます。
  **記録を削除したり別state-dirへ逃がして再実行せず、GitHubと手元の記録を人が照合してください。**
- 全ページ取得が上限（10,000 Issue）を超える、応答が過大/不正、APIが失敗する場合も起票を停止します。
- GitHubはこのAPIにDBとの分散トランザクションや本処理専用のidempotency keyを提供しません。
  複数PC・複数担当者の同時起票は保証対象外です。**1担当者・1state-dirで直列実行**し、参照markerを編集/削除しないでください。
  repo公開化のような他管理者操作も、GETとPOSTの間に完全には排他できないため同時に行わないでください。
- Cloud SQLへの書き戻しはしません。IssueとDBの片方だけが更新される経路をなくし、
  必要なトリアージ状態変更は本人が既存 `/feedback` 画面で行います。

## 検証と未実行の範囲

単体試験は本人スコープ/未認証/GCP無効、自由記述とURLの非転記、public/internal repo拒否、
ページング/closed Issue、計画改変、POST不明時の再送禁止、エラー非出力を架空データで検証します。
実際のフィードバック内容の取得、Issue作成、通知送信は自動テストで行いません。

公式API契約: [Get a repository](https://docs.github.com/en/rest/repos/repos#get-a-repository)、
[List repository issues](https://docs.github.com/en/rest/issues/issues#list-repository-issues)、
[Create an issue](https://docs.github.com/en/rest/issues/issues#create-an-issue)。
