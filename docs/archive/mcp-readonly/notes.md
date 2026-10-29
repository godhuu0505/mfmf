# AIとの接続 — 画面確認用

**2026-10-30、ローカル静的画面を利用者が確認し「この内容で進めていってください。」と承認したプロトタイプ。**

架空の家族とペットだけを使う。HTMLにCSS/JSを埋め込み、外部ファイル・API・DB・認証・写真・ブラウザストレージに依存しない。CSPの `connect-src 'none'` / `form-action 'none'` でも通信と送信を止める。リロードすると操作をリセットする。

## 確認すること

- Claude / ChatGPTごとに、接続先の**家族を1つ**選ぶ。owner / editor / viewerは利用でき、ゲスト権限だけでは利用できない。
- 保存済みの記録の日付・本文・記録の種類・入力済みの体重がAIへ渡ることを明示。家族の記録も含む。自由記述中の個人情報も渡り得る。
- 写真・動画・閲覧用URL・メンバー一覧・メールアドレスなどの会員情報・下書き・削除済み記録は対象外。記録・ペットの参照IDはツール内で使うが、会員情報として表示しない。追加・編集・削除・招待はできない。
- 接続は選んだ1家族に固定し、画面の「現在の家族」切替には追従しない。有効期限は最長30日。
- 接続一覧はサービス名、家族名、接続日時、有効期限で見分ける。同日・同じサービスの接続も時分秒まで表示する。
- 解除後に新しい閲覧を止めること、すでにAIが受け取った内容は削除されないことを伝える。
- 端末に合わせる / ライト / ダーク、長い家族名、所属家族なし、申込期限切れ、接続0件、同じAIの複数接続を切り替えられる。

## ローカルで開く

リポジトリのルートで（本番アプリの開発サーバーは使わない）:

```sh
node docs/archive/mcp-readonly/build.mjs
python3 -m http.server 5187 --bind 127.0.0.1 --directory docs/archive/mcp-readonly
```

URL: `http://127.0.0.1:5187/`

別ターミナルで `node docs/archive/mcp-readonly/verify.mjs` を実行すると、隔離したブラウザで操作・明暗・横はみ出し・通信先を検証し、`/tmp/mfmf-mcp-prototype/` に架空画面のスクリーンショットを保存する。インストール済みGoogle ChromeとPlaywrightを使い、通常のブラウザプロファイルやログイン情報は使わない。

## 手順上の位置

`.claude/skills/prototype/SKILL.md` §4は「Artifact ツールで proto/<slug>/index.html を publish し、URL をユーザーに渡す。」、§5は「実機で触って合意する」と規定している。明示的なfallbackの記載はない。

Artifact公開用ツールが利用できなかったため、利用者が明示的に求めたローカル確認環境で具体案とスクリーンショットを提示した。2026-10-30に明示承認を得て、受け入れ条件とE2Eを先に作成してから製品UIへ移植した。Claude実クライアントでのMCP接続試験の延期とは区別する。D27に従い、この静的画面と合意時の `spec.md` を手動でアーカイブした。

## 合意時のAPI連携メモ

- `GET /api/oauth/consent?transactionId=...` → `{transactionId, clientName, clientId, accountLabel, eligibleHouseholds:[{householdId, householdName, role}], csrfToken}`
- `POST /api/oauth/consent` body `{transactionId, householdId, approved}` → `{redirectTo}`。不許可時は家族未選択でも取り消せること。
- `GET /api/oauth/connections` → `{connections:[{id, clientName, householdName, createdAt, expiresAt}], csrfToken}`
- `DELETE /api/oauth/connections` body `{id}`

通常のアプリセッションと既存のIdentity CSRF境界を使う。家族IDはバックエンドで現在のメンバーシップを再検証し、OAuth grantへ固定する。MCP Bearerとは混用しない。現在の家族のCookieをMCP認可には使わない。

これはプロト用の連携メモであり、バックエンドの正はそのコードとテストに置く。
