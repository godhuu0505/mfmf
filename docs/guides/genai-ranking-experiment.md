# 架空のペット記録で Ranking API を試す

2026-10-27に、曖昧な質問から過去記録の候補を並べ替えられるか、**架空の日本語記録3件を1回だけ送信**して確認しました。
本番検索への組込みはしていません。実記録・写真・氏名・メールアドレス・DBへの接続は使いません。

[Ranking API](https://docs.cloud.google.com/generative-ai-app-builder/docs/ranking) は候補文書と質問を受け取るstateless APIです。
事前の索引・データストアは不要ですが、これはGoogle側の一切のログ保持が無いという意味ではありません。
API名はDiscovery Engineの `rankingConfigs.rank`、モデルは現在のガイドに載る `semantic-ranker-default-005` に固定します。
旧モデル名が残るRESTリファレンスの既定値や、将来変わる `@latest` に依存しません。

## 実行

Node 22と、対象プロジェクトを利用できる認証済みgcloudが必要です。実envファイルは不要です。

```bash
# 既定はdry run。認証・通信をしない
node scripts/genai-ranking-experiment.mjs

# 外部通信なしの安全性テスト
node --test tests/scripts/genai-ranking-experiment.test.mjs

# 対象プロジェクトでAPIを有効化する場合（管理権限が必要）
gcloud services enable discoveryengine.googleapis.com --project=YOUR_PROJECT_ID

# 明示したときだけ、組込みの架空3件を1リクエスト送る。自動再試行なし
node scripts/genai-ranking-experiment.mjs --execute --project=YOUR_PROJECT_ID

# gcloudがPATHに無い場合は --gcloud=/absolute/path/to/gcloud を追加
```

実行ごとに最大1リクエストです。今回の実験は成功した1回で終了し、CIでは実APIを呼びません。
CLIは任意のquery・ファイル・標準入力を受け付けず、Supabase等のアプリ依存を読み込みません。
APIの有効化以外に、データストア・検索アプリ・常時実行サービス・定期実行を作りません。
実行権限には `discoveryengine.rankingConfigs.rank` が必要です（[REST仕様](https://docs.cloud.google.com/generative-ai-app-builder/docs/reference/rest/v1/projects.locations.rankingConfigs/rank)）。
権限不足の場合は広いロールを自動付与せず終了します。

`gcloud auth print-access-token` の出力は子プロセスからメモリへ取り込み、HTTPSのAuthorizationヘッダだけに使います。
トークンをコマンド引数・ファイル・標準出力へ出しません。失敗時も認証出力やHTTP応答本文を伏せます。
`ignoreRecordDetailsInResponse: true` を指定し、出力はさらに既知の架空IDと数値scoreだけへ絞ります。

## 1回の実測

質問は「保育園のあと、くたびれてのんびり過ごしたのはどの記録？」。
入力の全文は [実験スクリプト](../../scripts/genai-ranking-experiment.mjs) にあり、実在の記録から転記していません。

| 架空ID | 内容の要約 | score（降順） |
| --- | --- | ---: |
| `synthetic-rest` | 保育園で遊び、帰宅後は静かに休息 | 0.6911 |
| `synthetic-rain` | 保育園を休み、雨の日に室内で元気に遊ぶ | 0.4822 |
| `synthetic-grooming` | サロン帰りに庭を歩く | 0.3547 |

期待する記録が先頭になりました。ただし3件・1質問の疎通確認で、検索精度や本番採用を証明していません。
scoreは関連度であり、事実の確率ではありません。候補に含まれない記録を発見する機能でもありません。
次に進むなら、言い換え・否定・時期・対象ペットを混ぜた架空の評価集合で、現行のキーワード検索との比較を先に行います。
実データを使う段階は別途判断し、**RLSで閲覧可能な候補に絞った後**に外部へ送る設計と、送信範囲・保持条件の確認が必要です。

## 料金とクレジット

[公式料金表](https://cloud.google.com/generative-ai-app-builder/pricing#ranking_api_pricing) の通常料金は
**$1 / 1,000回**。1回は最大100文書で、101件以上は100件ごとに切り上げます。
今回の3件×1回は **$0.001**、1 USD = 150円の仮定で約 **0.15円（税別）**です。
一般検索の無料クエリ枠がRankingにも使えるとは扱っていません。

**GenAI App Builderクレジットの実適用は未確認**です。APIの成功や小額であることは適用の証拠になりません。
Billingへ利用が反映された後にサービス・SKUと適用されたクレジットを照合するまで、値引きとして計上しません。
小額のため円表示で丸められる場合も、0円表示だけではクレジット利用の有無を判定しません。
クレジットをCloud Run / SQL等の一般インフラや、一般のGemini APIへ転用できるとも約束しません。

## 名前と古いAPIの注意

旧Generative AI App Builder / Vertex AI Searchの資料は、現在Agent Searchという名前で案内されています。
APIエンドポイントはDiscovery Engineを使います。

価格ページにはGrounded Generationの項目が残っていますが、
[2025-04-07の公式リリースノート](https://docs.cloud.google.com/generative-ai-app-builder/docs/release-notes#April_07_2025) は
旧 `generateGroundedContent` が利用できなくなったと明記しています。
Googleの後継推奨は `generateContent` によるgroundingであり、古い料金表の掲載だけで旧APIが動くと判断しません。
今回利用したRanking APIは回答生成とは別の現行APIです。生成による回答・要約やGemini呼び出しは追加していません。
