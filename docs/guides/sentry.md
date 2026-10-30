# Sentry の安全な有効化

Sentry は運営者向けの障害分類と、限定した画面性能の確認に使います。
`SENTRY_DSN` 未設定・形式不正なら SDK は初期化せず、Sentry へ通信しません。
実 DSN・アカウント設定・到達確認は運用の受入条件であり、コードのマージだけで有効化済みとはしません。

## 送信する情報と、送信しない情報

例外は **固定の分類、固定の画面分類、既知のJavaScript例外型、ランダムなイベント識別子**だけに変換します。
例: `server` / `/records/[id]` / `TypeError`。エラー本文・stack・コード周辺・関数引数・フォーム内容・記録本文・写真・
オブジェクトパス・署名URL・メール・UID・世帯ID・Cookie・Authorization・任意URL・query・fragmentは送りません。
原文を正規表現で部分マスクする方式ではなく、許可した項目だけで新しいイベントを作ります。

SDKのscopeや自動付加情報も含めて、`beforeSend` と最終transportの両方で投影します。
最終envelopeはerrorと既知Web Vitalsだけを許可し、attachment・breadcrumb・request・user・context・trace header・
log・session・replay・profile・check-in・client reportを送信しません。
例外の`event.sdk`は`{ settings: { infer_ip: "never" } }`だけを固定生成します。
SDK名・version・packagesや呼出元のsettingsは引き継ぎません。SDKの`sendDefaultPii: false`やuserの省略だけでは、
Sentry側がJavaScriptイベントへ接続元IPを補完するため不十分です。最終transportでもこの固定値を再設定します。
Session Replay、browser SDK、HTTP/SQL tracing、profiling、console転送は導入しません。
Sentry build pluginも使わず、source map・build token・ソースコードのuploadはありません。
`SENTRY_TRACES_SAMPLE_RATE` が既存環境に残っていても読みません。トレースは無効です。

この制限により、Sentryから利用者や個々の記録を特定したり、元のstackを調査したりはできません。
固定分類と配信時刻を手掛かりに、運用ログ・ローカル再現・本人の問い合わせで調べます。
Sentryが受け取るHTTP通信元はサーバーです。ブラウザーからSentryへ直接送信しません。

## Sentry側のプライバシー前提

本番有効化には、Sentry組織のserver-side data scrubbing・`Require Using Default Scrubbers`・
**Prevent Storing of IP Addresses**（APIでは`scrubIPAddresses: true`）・enhanced privacyを有効にし、
匿名Issue共有を無効にすることを必須とします。projectでの設定だけに依存せず、組織側で適用を確認します。
`Require Using Default Scrubbers`は2026-10-29に有効化し、画面の再読でValue 1を確認済みです。
標準scrubberだけに依存せず、明示した機密フィールドと新規イベントの保存結果も実測します。

IP推測停止と位置情報の除去は別です。Relayは`infer_ip: never`でも接続元IPから`user.geo`を補完する経路を持ちます。
`user.geo`のAdvanced Data Scrubbingルールだけを設定した実測でもgeoが残ったため、そのルールだけでは受入済みとしません。
[Sentry公式手順](https://www.sentry.help/en/articles/13964201-can-i-disable-ip-geolocation-for-gdpr-compliance)に従い、
Data ScrubbingのSensitive Fieldsへ、次の5項目を1行ずつ追加します。
共通の組織設定（Global Sensitive Fields）を使う場合も対象projectへ適用されることを確認します。

```text
city
subdivision
region
country_code
ip_address
```

既存の機密フィールドやscrubbing rulesは保持します。公式の反映時間は**5〜15分**です。
設定保存から15分以上待ち、固有event IDの新しい合成イベントを1件だけ送信して、
そのイベント詳細でIP・city・subdivision・region・country_codeの実値が無いことを確認します。
削除済みまたは明示的なredaction表示を確認し、値をログや証跡へ転記しません。
古いイベントやIssue全体の集計表示で判定せず、未反映・不明時は追加送信せず設定と対象IDを調べます。
**新規イベントの保存結果の実測が不可欠**であり、unit testやHTTP 200だけでは証明できません。

これらの設定は新規イベントに適用され、既存イベントを遡って消去するものではありません。
設定前の合成テストにIPやgeoが残った場合は、そのイベントを含むテストIssueの削除を別途確認します。
外部サービスへのHTTP通信自体には送信元IPが必要であり、Sentry基盤のアクセスログ等まで収集しない保証ではありません。

## ブラウザー例外と Web Vitals

- React error boundary、ルートerror boundary、`error`、`unhandledrejection` を固定categoryで報告します。
  `event.error`、rejection reason、DOM、resource URLにはアクセスしません。
- ブラウザーは `/api/vitals` のGETで有効/無効だけを一度確認し、無効ならPOSTしません。
  `NEXT_PUBLIC_SENTRY_DSN`、公開build引数、新しいCookieやlocalStorageは不要です。
- 既存middlewareの認証確認を維持します。匿名GET/POSTは204で破棄し、ログイン前のブラウザー障害は対象外です。
  ログイン画面の稼働確認は別のuptime監視で補います。回復・招待Cookieを計測のために消費しません。
- POSTは同一originのJSONのみ、UTF-8本文1KiB以内・読取2秒以内。未知fieldは拒否します。
  画面はクライアントとサーバーの両方で固定分類へ変換し、queryや動的IDは送信前に落とします。
- Web Vitalsは `CLS/FCP/INP/LCP/TTFB` の5種だけです。documentの10%を抽出し、各種を最大1回送ります。
  `rating` / `navigation_type` は固定enum、値は非負有限数（CLS≤10、時間≤120秒）、小数3桁に制限します。
  metric IDは送りません。属性は`route/rating/navigation_type`だけです。
- Metricsで`web_vital.lcp`等を`route`別に集計できます。ただし抽出・上限制限付きの標本なので、
  リクエスト数・利用者数・DAU・完全なエラー件数を表すものではありません。少数標本のp75は慎重に扱います。

## 費用と送信量の制限

| 範囲 | 制限 |
| --- | --- |
| browser document | error最大3件、同category再送なし。性能は10%抽出、5種各1回 |
| API process | 有効な同一origin JSON要求を最大60回/分 |
| 最終送信process | error最大3件/分・60件/日、metric最大30件/分・360件/日 |
| 通信 | transport queue最大4、3秒timeout、redirect禁止、Sentryの429/rate-limitを尊重、独自retryなし |
| accepted API | flush最大500ms。通知失敗で画面の操作は失敗させない |

processのcounterは再起動で消え、複数revision/instanceでは合算されません。
**これらは無料枠・月額の上限保証ではありません。** Sentry管理画面で利用可能な無料プラン、Errors/Metricsの枠、
超過課金無効またはspend limit、通知先を確認してから有効化します。プランの数値はアカウントの現行表示を正とします。
枠が足りなければまず計測を止め、画像保全や復元品質を削って費用を合わせません。

## 本番の設定・受入

1. 本人がSentryアカウントと専用projectを用意し、規約・プラン・送信先regionと上記の組織側プライバシー設定を確認する。
2. 現コードが受け入れるSaaS DSNは `https://<32桁hex public key>@o<数字>.ingest[.us|.de].sentry.io/<project番号>`。
   self-hostedや別の形式は黙って許可せず、宛先契約とtestsを先に更新する。
3. root担当の配信手順でSecret Managerの固定versionを**新revisionだけ**へ渡す。
   フィルター導入前の旧revisionへ先にDSNを設定しない。DSNをチャット・ログ・public artifact・build contextへ出さない。
4. CIの秘密marker fixtureで、SDK実シリアライズ後のenvelopeに原文・添付・URL・任意属性が無いことを確認する。
5. 承認済みの架空例外でSentry到達・分類・通知・使用量、保存イベントのIP/geo不存在を確認する。実利用者のデータで試験しない。
   新しい公開「エラーを投げる」endpointは作らない。ブラウザーglobalには`Sentry`を公開しない。
6. DSNを外したrevisionで通信が止まること、アプリ本来のログイン・表示・保存に影響しないことを確認する。

source mapやraw stackを後から有効にする場合は、別のprivacy設計と受入が必要です。

## 実装と一次資料

- `src/instrumentation.ts`: Nextの`onRequestError`で固定分類だけをcapture。
- `src/lib/telemetry/privacy.ts` / `transport.ts`: 二段の投影と送信先固定。
- `src/lib/telemetry/client.ts` / `limits.ts`: browser/documentとprocessの上限。
- `src/app/api/vitals/route.ts`: 認証middleware下の同一origin受け口。
- SDK契約はインストール済み`@sentry/nextjs` v10系の型・実シリアライズをtestsで確認。
  [公式Options](https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/)と
  [Filtering](https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/filtering/)を参照。
  SDK更新時はeventだけでなくmetric envelope・rate limit・attachment除去の実SDK試験も維持する。
- IP推測の根拠: [Relayの固定SDK設定](https://github.com/getsentry/relay/blob/ac463005933167023fc03b229e8ced7de646f7bc/relay-event-schema/src/protocol/clientsdk.rs#L26)と
  [IP補完処理](https://github.com/getsentry/relay/blob/ac463005933167023fc03b229e8ced7de646f7bc/relay-event-normalization/src/event.rs#L423)。
  [geo補完](https://github.com/getsentry/relay/blob/ac463005933167023fc03b229e8ced7de646f7bc/relay-event-normalization/src/event.rs#L507)は別処理。
- 組織側の設定は[公式Organization API](https://docs.sentry.io/api/organizations/update-an-organization/)を参照。
  IP保存禁止とadvanced scrubbingは新しい受信イベントが対象で、実設定と保存結果を別々に確認する。
