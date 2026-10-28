# インフラを Google Cloud へ寄せる — アーキテクチャ案

この文書は2026-10-26の段階移行計画と、その後の実装差分を記録します。
D18からD38への判断の経緯や検討段階のコード例は履歴として残します。
**運用の正は以下の現行実装へのリンクです。本文の案・旧P3/P4分割手順をそのまま本番へ実行しないでください。**

## 現在の実装と切替記録

**DB・認証の切替と本人の書込を確認済み。** managed restoreと全行全列一致、新しいbackup、GCP候補100%へのpromote、実Googleログイン・画面一致・軽量並行GETを確認しました。
ログイン後の再照合でfrozen/gcsの全行全列一致を確認してから、2026-10-28 18:03:33.456726 UTCにactivationが成功し、DB書込enabled・media gcsへ切り替わりました。
同じ本人プロフィールを同値で保存できたことも確認済みです。事後inspectでDB enabled・media writes gcs・read backend gcs・imported=trueと全件数の維持を確認しました。切替記録を確定した[PR193](https://github.com/godhuu0505/mfmf/pull/193)の[全7 CI](https://github.com/godhuu0505/mfmf/actions/runs/40742163316)は成功済みで、通常配信の結果は下表の実行記録を参照します。

| 層 | 実装と正 |
| --- | --- |
| 配信 | Cloud Run。Next.js＋loopback PostgREST＋Cloud SQL Auth Proxyを単一containerで実行。1CPU/1GiB、concurrency2、min0/max1、DB pool2 |
| DB | 東京・PostgreSQL 17・Enterprise・db-f1-micro・単一ゾーン。Private IP、connector必須、Direct VPC private-ranges-only。HA/NAT/常時connectorは追加しない |
| Auth | Identity Platform。既存providerとUUIDの対応を確認し、serverで失効確認・内部UUID対応・RLS用の短期tokenを作る。[認証境界](../../src/lib/identity/README.md) |
| データアクセス | `src/lib/supabase/server.ts` の入口を維持し、GCPモードではserver専用bridgeへ分岐。SDKはPostgRESTクエリビルダにだけ使う。下記の直接pg/withUser案は採用していない |
| 画像 | 非公開GCS、DB台帳・世代・binding・全byte hashで検証。[画像移送手順](../guides/storage-migration-operator.md) |
| スキーマ／CI | [`db/gcp/`](../../db/gcp/README.md) のbaseline・checksum・元migration集合照合と実PostgreSQL/PostgREST試験。ローカルSupabaseと従来suiteも残す |
| 通常配信 | [GCP DB通常配信](../guides/gcp-database-deployment.md)。trueモードでは旧Supabase migration/Vercel配信をskip。初回切替・import・activateは自動実行しない |

今回のDBとAuthは最終source snapshotを共通にして切り替えます。旧計画の「DBだけ先に切り替え、後でAuth」を採用しません。
元Supabaseのpublic20表ALWAYS＋credential Auth6表ORIGINを厳格なreplica回避防止条件付きで凍結し、dump前後を検査します。
全27Auth表を照合して未対応18表が非空なら停止します。元DB・原本・旧画像は削除せず保全します。
Auth session等の一時データを含む「全Auth状態の凍結」を意味しません。管理設定変更も別途禁止します。

| 切替の証跡 | 状態 |
| --- | --- |
| 最終source26guard／schema3・暗号化原本、IdP UUID/provider対応、GCS全件hash/binding | 確認済み |
| IdP手動暗号化export・独立復号・restore plan | 確認済み（4ユーザー・Google4・BCRYPT1・再設定必須0。実account restoreは未実施） |
| 最終Cloud SQL import・復元後verify-import全行全列結果・inspect | 確認済み。復元後も全行全列一致、frozen/gcs |
| managed backup同instance復元・設定確認・新しい復旧点 | 確認済み。18分47.589秒、backup設定一致・修復不要、post-restore backup成功 |
| GCP候補100%へのpromote・canonical frozen login | 確認済み。2026-10-28 17:54:23 UTCにpromote。実Googleログイン後、profileの既定記入者・同じ世帯owner・同じpet・空のhomeが旧画面と一致 |
| 軽量2並行GET | `/settings/account` 200・742.901ms、`/pets` 200・675.654ms。今回の現revision観測範囲で5xx/WARNなし。単発smokeであり負荷保証ではない |
| ログイン後のDB再照合 | verify-importで全行全列一致、frozen/gcsを再確認。画面一致だけでDBの同一性を判断していない |
| activation・本人の書込確認 | 2026-10-28 18:03:33.456726 UTC成功、changed=true・DB enabled・media gcs。18:04:29 UTCに既存profileの同値保存と成功表示を確認 |
| activation後inspect | 確認済み。DB enabled・media writes gcs・read backend gcs・imported=true、全件数維持 |
| 切替記録PR193のCI | [run40742163316](https://github.com/godhuu0505/mfmf/actions/runs/40742163316)：全7 checks成功。main `2a37a40` へmerge済み |
| Job通常形への復帰・workflow再開 | 確認済み。通常3項目のenvを検証し、upgradeはapplied=0・sourceManifestVerified=true。workflow state=active、GCP_AUTH_ENABLED/GCP_DEPLOY_ENABLEDともtrue |
| main `2a37a40` の通常配信 | [Deploy Production run40743471560](https://github.com/godhuu0505/mfmf/actions/runs/40743471560)の実行結果を参照。CI成功と配信成功は別に確認する |

source凍結からactivationまでは47分21.116秒でした。この一回の実測であり、次回の停止時間や復旧時間を保証するものではありません。
復旧の限界は [デプロイ手順](../guides/deploy.md#バックアップと復旧範囲)を参照します。
Cloud SQL自動backup/PITR設定、同instance backup復元の実証、別instanceへのPITR実証は別です。
IdPは手動暗号化exportと独立した復号・restore plan検証が成功し、4ユーザー・Google link4件・BCRYPT1件を保全しました。今回は再設定必須0件です。定期自動backupや実アカウントrestoreは未実施で、復旧点は最後に検証成功した手動export時点です。
Standard on-demandは無期限のため、未適用SQLの通常upgradeは保持・削除手順を実証するまで停止します。

---

## 0. 先に結論

| | |
| --- | --- |
| **採る形** | Cloud Run（Next.js）＋ Cloud SQL for PostgreSQL ＋ Identity Platform ＋ Cloud Storage |
| **守るもの** | `public` の **既存RLS・関数の認可契約・Storage非依存のpgTAP**を保ち、互換DBで検証する |
| **作り直すもの** | Storageの認可、**`delete_own_household`**、**Storageを参照するpgTAP**（§4.2） |
| **データAPI** | Supabaseの外部PostgREST接続をserver専用loopbackへ移す。`supabase-js`のクエリビルダとServer Action認可は維持 |
| **費用** | 月3,000円は条件付き目標。31日・復元検証予備込み約2,851円、Run無料枠を使えなければ約3,128円。正価・税・使用量の前提は§6 |
| **利用者影響** | P1 はまず別の `run.app` URL で検証。公開URLを変更する場合は再ログインとPWAの再インストールを確認する。P3 の停止時間は復元リハーサルの実測後に決め、30〜60分を保証しない |

D38 は D18 の無料枠限定方針を移行後の構成について変更します。運用対象を絞る方針と
RLSによるデータ分離は維持します。自動バックアップ・PITR・写真の世代管理は復旧手段を
増やしますが、**設定と復元試験が完了するまでは保護できたと扱いません**。
用途限定のGenAIクレジットは一般インフラへの適用を確認できていないため、予算から差し引きません。

---

## 1. いま何を移すのか

移行の対象は呼び出し先と認可の契約で棚卸しします。旧PR #146の固定件数は予定機能の追加前だったため、
移行時点のコードを正とし、件数を移行完了の根拠にしません。

| 依存 | 移行で維持・置換する契約 |
| --- | --- |
| publicテーブル・関数・RLS | auth.uid / jwt、世帯・role・ゲスト・予定の期間と版、FK・削除ガード |
| PostgREST | src配下のfrom / rpcを同じ認可付きDB経路へ移す。scriptsも対象 |
| Auth | Google / email、Cookie、確認済みメール、招待、再設定、失効 |
| Storage | privateな写真・アバター、直接アップロード、署名URL、削除・孤児掃除 |
| pgTAP / Integration | 予定のschedule_testも含む現行全suiteを基準にする。Storage非依存は互換DBへ、Storage依存は署名・実GCS契約の試験へ移す |
| Realtime / Edge Functions | 現在未使用。導入済みと仮定しない |

未使用のものが 2 つあるのは幸運です。移すのは **DB・認証・ファイル**の 3 つだけで、
そのうち難所は **RLS の再現**と **Storage の認可**の 2 点に集中しています。

---

## 2. 3 つの案と、却下したもの（検討当時の比較）

> **この節は要約です。** 評価観点を外部の枠組み（Well-Architected の 6 本柱／技術選定の
> MCDA・ADR／ロックインの出口テスト）から引き直し、レイヤごとの候補を出して重み付きで
> 採点し直したものが [gcp-tech-selection.md](./gcp-tech-selection.md) にあります。
> **結論（案 B）は変わりませんでしたが、配信層に対抗馬（Firebase App Hosting）が 1 つ増え、
> 「GCP に無料の Postgres は無い」という前提が不正確だったことが分かりました。**

```mermaid
flowchart LR
  subgraph A["案A: Firestore 全面移行"]
    A1["Firebase App Hosting"] --> A2["Firestore<br/>Security Rules"]
  end
  subgraph B["案B: 忠実移植 ★採用"]
    B1["Cloud Run"] --> B2["Cloud SQL<br/>RLS そのまま"]
  end
  subgraph C["案C: Supabase を自前ホスト"]
    C1["Cloud Run"] --> C2["GoTrue / PostgREST /<br/>Storage / Kong / Cloud SQL"]
  end
```

| 案 | 費用/月 | コード変更 | 却下/採用の理由 |
| --- | --- | --- | --- |
| **A. Firestore + Firebase App Hosting** | 約 ¥0 | **全面書き換え** | **却下。** 費用は最良だが、既存テーブルの結合・`pg_trgm` の部分一致検索・**既存RLSとpgTAP** が全部消える。セキュリティの一次防衛線を書き直したうえで、それを守るテストも書き直すことになる（`CLAUDE.md` セキュリティ節の前提が崩れる）。家族2人のアプリでこのリスクを取る理由がない |
| **B. Cloud Run + Cloud SQL + Identity Platform + GCS** | 約2,400〜2,700円（税込概算） | **データアクセス層 ＋ Storage ＋ 認証** | **採用。** SQL と RLS が資産として残り、`auth` 互換シム（§4.1）で **publicの認可契約とStorage非依存の関数・pgTAPを維持する**。ただし作業は「データアクセス層だけ」では終わらない —— **Storage のアップロード/削除経路、`.auth.*` の全呼び出しとログイン/登録/再設定/OAuth の各フロー、migration のベースライン、Storage 系 pgTAP 4 ファイルの Integration への作り替え**が必須（§4・§7） |
| **C. Supabase OSS を Cloud Run で自前ホスト** | 約 ¥3,500〜 | **ほぼ無し** | **却下。** コード変更が最小という一点は魅力だが、GoTrue・PostgREST・storage-api・Kong の 4 コンテナを自分でバージョン管理・監視・アップデートすることになる。「運用対象を増やさない」（D18）に最も強く反する案で、費用も一番高い。コードを守るために運用を買うのは逆 |

---

## 3. 目標アーキテクチャ（検討当時の案）

### 3.1 レイヤの対応

```mermaid
flowchart LR
  V["Vercel Hobby<br/>Next.js 配信"] --> CR["Cloud Run<br/>Next.js standalone"]
  SA["Supabase Auth<br/>GoTrue"] --> IP["Identity Platform<br/>Google + password"]
  SD["Supabase Postgres<br/>RLS"] --> SQL["Cloud SQL for PostgreSQL<br/>RLS そのまま"]
  SS["Supabase Storage<br/>行レベルポリシー"] --> GCS["Cloud Storage<br/>署名 URL + アプリ側認可"]
  PR["Supabase PostgREST<br/>クエリ / RPC"] -.->|"置換"| X["認可付きサーバーDB経路"]
  VE["Vercel の環境変数"] --> SM["Secret Manager"]
  GA["GitHub Actions<br/>+ Vercel CLI"] --> GA2["GitHub Actions<br/>+ WIF"]
```

PostgRESTのクエリとRPCを、Private IPのCloud SQLへつなぐ認可付きサーバーDB経路へ置き換えます。
現行のブラウザクライアントは主にAuthとStorageの直接アップロードを使い、DB変更は既にServer Actionです。
ただし公開されたPostgREST自体は有効なJWTで呼べるため、移行・凍結時はUIだけでなくAPIの書き込みも制御します。

### 3.2 リクエストの経路

```mermaid
flowchart TB
  U["ブラウザ / PWA"]
  U -->|"HTTPS"| CR["Cloud Run<br/>Next.js SSR + Server Action"]
  U -->|"サインイン"| IP["Identity Platform"]
  IP -->|"ID トークン"| CR
  CR -->|"セッション Cookie<br/>__Host-session"| U
  CR -->|"Private IP / VPC 直接エグレス<br/>SET LOCAL role + claims"| SQL[("Cloud SQL<br/>PostgreSQL 17")]
  CR -->|"V4 署名 URL を発行"| GCS[("Cloud Storage<br/>写真 / アバター")]
  U -->|"署名 URL で PUT / GET<br/>本体は Cloud Run を通らない"| GCS
  CR -->|"DB パスワード / 暗号鍵"| SM["Secret Manager"]
  CR -->|"構造化ログ / エラー"| OBS["Cloud Logging<br/>Error Reporting"]
```

要点は 3 つです。

- **画像の本体は Cloud Run を通りません。** 今も Vercel の 4.5MB ボディ上限を避けるために
  ブラウザから Storage へ直接上げていますが（`RecordForm`）、この形はそのまま維持します。
  Cloud Run の上限は 32MB なので制約としては緩みますが、**転送とメモリを Cloud Run に
  払わせない**利点の方が大きいので変えません。
- **Cloud SQL は Public IP を持ちません。** Cloud Run から VPC 直接エグレスで Private IP に
  つなぎます。インターネットから DB に到達する経路が存在しない状態にします。
- **サービスアカウントの JSON 鍵はどこにも置きません。** 署名 URL の発行は鍵ファイルではなく
  IAM の `signBlob` で行い（§4.2）、GitHub Actions は Workload Identity 連携で認証します（§5）。
- **`NEXT_PUBLIC_*` は Secret Manager では配れません。** §3.1 の表で「環境変数 → Secret Manager」と
  まとめましたが、**それは実行時に読む値の話**です。`NEXT_PUBLIC_*` は
  **ビルド時にブラウザ用バンドルへ焼き込まれる**ので、いまの CI のように
  プレースホルダでビルドしたイメージを Cloud Run に置くと、**P1 の時点でログインと
  Storage への直接アップロードが壊れます**（P4 でブラウザ側 Identity Platform の
  設定を配るときも同じ）。これらは**秘密ではない**ので、
  **ビルド時に渡す**か、**実行時に読む設定ドキュメントを配る**経路を別に用意すること。

### 3.3 配信まわりの割り切り

| 論点 | 決め |
| --- | --- |
| 公開URL | 初期検証は Cloud Run 標準の **`run.app` URL**。現在の `vercel.app` URLはDNSでGoogle側へ移管できない。独自ドメインを採用する場合は別途方式と費用を評価する。[Cloud Run domain mapping](https://docs.cloud.google.com/run/docs/mapping-custom-domains) はPreviewで本番非推奨のため、既定にしない。ALBは今回の月額に含めない |
| コールドスタート | **最小インスタンス0・リクエスト課金**。ナビゲーションはネットワークを待つため、P1で初回遷移を実測する。常時1台への変更は月額を再試算して判断する |
| next/image の最適化 | 写真の縮小はブラウザ側（D20）。`sharp` はNextの依存に含まれるため、standalone成果物を手作業で削らず実際のコンテナ起動を検証する |
| リージョン | `asia-northeast1`（東京）。利用者も Cloud SQL も同じ場所に置く |

---

## 4. 難所は 2 つ半（検討当時の設計例）

### 4.1 難所その 1 — RLS を Supabase 無しで動かす

**RLS を捨てないことがこの移行の成否です。** `CLAUDE.md` が「セキュリティの一次防衛線は
Supabase の RLS」と書き、pgTAP がそれを CI で守っている以上、ここを弱めた時点で移行は失敗です。

Supabase がやっていることは、実は魔法ではありません。PostgREST が JWT を検証し、
**トランザクションの頭で 2 行の `SET LOCAL` を実行しているだけ**です。
`auth.uid()` はその設定値を読む関数にすぎません。であれば、同じことを自分でやればよい。

```mermaid
sequenceDiagram
  participant B as ブラウザ
  participant CR as Cloud Run<br/>Server Action
  participant P as 接続プール
  participant DB as Cloud SQL

  B->>CR: セッション Cookie 付きリクエスト
  CR->>CR: Cookie 検証 → user_id と検証済み email を得る
  CR->>P: withUser(userId) でトランザクション開始
  P->>DB: BEGIN
  P->>DB: SET LOCAL role = 'authenticated'
  P->>DB: SET LOCAL request.jwt.claims = '{"sub":"…","email":"…","role":"authenticated"}'
  CR->>DB: SELECT ... FROM daycare_records
  DB->>DB: ポリシーが auth.uid() / auth.jwt()->>'email' を評価<br/>= current_setting('request.jwt.claims')
  DB-->>CR: 権限のある行だけ
  P->>DB: COMMIT（SET LOCAL は自動で消える）
```

用意するのは以下だけです。

- **`auth` スキーマの互換シム** —— **通常の migration として後ろに足してはいけません**（後述）
  - `auth.uid()` / `auth.jwt()` / `auth.role()` — `current_setting('request.jwt.claims', true)` を読む
  - ロール `anon` / `authenticated` / `service_role`
  - **`auth.users` テーブル** — 既存の外部キーの参照先。Identity Platform を正とし、
    サインイン時に `id` / `email` **とメール確認状態**を upsert して同期する（下記）
- **`withUser()` ヘルパー**（`src/lib/db/`）— 上のシーケンスを必ず通す唯一の入口。
  **claims は文字列連結で組み立てないこと**（下記）
- **接続プール専用のログインロール** —— これが無いと上のシーケンスは 1 行目で落ちます（下記）

> **claims には `email` も必ず入れること。** `sub` と `role` だけでは足りません。
> `20260704010000_household_invites.sql:79` の `invites_select_invitee` は
> `lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))` で判定しているため、
> `email` が空だと**招待の受諾画面（`/invite/[token]`）が全ての有効な招待を「無効」と表示します。**
> 入れる値は **ID プロバイダが検証済みとしている email** に限ること（自己申告の email を
> 入れると、他人の招待を受諾できる経路になります）。

> **claims を締めるだけでは穴が塞がりません。** 招待受諾の本体
> `accept_household_invite` は **`auth.jwt()` ではなく `auth.users` を直接読んでいます**
> （`20260705010000_guest_invites.sql:96` の `select lower(u.email) ... from auth.users`）。
> つまり**未確認のメールを互換テーブルに書いた時点で、claims の制限を迂回して
> 招待やゲスト付与を受け取れます**（招待一覧の SELECT ポリシーで行が見えなくても、
> トークンさえ知っていれば RPC は通る）。対応は 2 つのどちらか。
>
> - **未確認のメールを `auth.users` に書かない**（確認済みになるまで `email` は NULL のまま）。
>   **保存された関数に手を入れずに済むので、こちらを既定にします。**
>   代償として、未確認ユーザーはメンバー一覧でメールが空に見えます
> - **確認状態を列として持ち、RPC 側で検査する。** 表示は自然になりますが、
>   **「無改変で残す関数」がもう 1 本減ります**（§4.2 の `delete_own_household` に次いで 2 本目）

> **`auth.users` への同期は、アプリのプールからは書けません。** 上で決めたログインロールは
> **テーブル所有者でない `authenticated` 相当**なので、互換テーブルへの upsert 権限がありません。
> かといって**素直に UPDATE 権限を与えると、アプリの任意のクエリが他人の identity の
> email を書き換えられる**ようになり、この表を信頼している招待系の関数
> （`accept_household_invite` ほか）がまるごと崩れます —— **`withUser()` の中で
> 認可を握っているのは RLS なのに、その前提となる identity 自体を書けてしまう**からです。
> **サーバーが検証した identity だけを受け取り、行の id を認証済みの本人に束縛する
> 狭い SECURITY DEFINER 関数**（または同期専用のプロビジョニングロール）を用意すること。

> **claims は必ずパラメータで渡すこと。この 1 点で移行全体が無意味になり得ます。**
> 上の図は読みやすさのために `SET LOCAL request.jwt.claims = '{...}'` と書いていますが、
> **実装でこの文字列を組み立ててはいけません。** `SET LOCAL` は値をパラメータに取れないため
> 素直に書くと文字列連結になり、**引用符を含むメールアドレスでリテラルを閉じて
> claims を丸ごと差し替えられます** —— つまり `auth.uid()` に他人の UUID を入れられ、
> **`auth.uid()` を信頼している全てのポリシーが一斉に破れます。**
> `select set_config('request.jwt.claims', $1, true)` の形で、**claims をシリアライズした
> 1 個のパラメータとして渡す**こと（`true` がトランザクション限定＝ `SET LOCAL` 相当）。

> **接続は TLS を強制すること。** Private IP に閉じるのは「インターネットから届かない」だけで、
> **PostgreSQL が勝手に TLS を張るわけではありません**。素の `pg` は既定で**暗号化なし**に
> つなぐので、**DB のパスワードと家族の記録が VPC 内を平文で流れます**。
> Cloud SQL 側で暗号化必須にして証明書検証を設定するか、**Cloud SQL コネクタ /
> Auth Proxy を使って保護された経路を張る**こと（コネクタなら mTLS が既定で付く）。

> **接続プールのロールを別に用意すること。** 普通のログインロールは、`authenticated` を
> **GRANT されていない限り `SET ROLE authenticated` を実行できません**（毎クエリの 1 行目で落ちます）。
> かといって手近な `postgres` / migration 用アカウントで通すと、**スーパーユーザーまたは
> テーブル所有者として RLS を素通りする**ので、`withUser()` を 1 箇所でも迂回した瞬間に
> テナント分離が消えます（一次防衛線が消える = 最悪の失敗の仕方）。用意するのは
> **スーパーユーザーでない・テーブル所有者でない・`BYPASSRLS` を持たない専用ログインロール**で、
> `authenticated` を `NOINHERIT` で GRANT します（明示的に `SET ROLE` したときだけ権限が乗る）。
> **migration 用の資格情報はアプリのプールに入れないこと。**

### 4.1.1 履歴をそのまま再生できるようにする —— ベースラインを切る

シムの話には続きがあります。**`auth` だけ用意しても、素の `postgres:17` では履歴の再生は
`init.sql` で止まります。** 依存しているのは `auth` だけではないからです。

| 依存 | 場所 |
| --- | --- |
| `storage.buckets` への `insert` | `20260616130704_init.sql:128` |
| `storage.objects` へのポリシー、`storage.foldername()` | `init.sql:134-155` ほか、後続の migration 多数 |
| `extensions` スキーマ（`pg_trgm` の置き場所） | `20260616130707_record_search.sql:11` |

既存の migration は編集しない方針なので、選択肢は 2 つです。

1. **ベースラインを切る（推す）** —— P3 の切替時点のスキーマをダンプし、
   **Storage 関連を除いたベースライン**を新しい起点にする。以後の CI・staging・
   災害復旧はベースライン＋それ以降の migration だけを再生する。**Storage の残骸を
   1 行も持ち込まずに済む**のが利点で、履歴の再生自体は P3 で一度きりなので失うものは少ない。

   > **ただし「`0000_baseline.sql` を置く」だけでは起点になりません。** マイグレーションの
   > 実行順はファイル名順なので、`0000_...` は既存の `2026...` より**前**に走り、
   > そのあと **`init.sql` 以下の履歴がそのまま再生されてしまいます**（＝ Storage 依存で
   > 落ちる状態に逆戻り）。**旧い migration を置くディレクトリごと分ける**か、
   > **ベースライン適用時に「それ以前のバージョンは適用済み」と管理テーブルへ記録する**か、
   > どちらかを必ずセットで用意すること。**ここを踏み外すと、CI も staging も
   > 災害復旧も同じ場所で落ちます。**
2. **Storage 互換スキーマも bootstrap に入れる** —— `storage.buckets` / `storage.objects` /
   `storage.foldername()` の**空の器**を作って履歴を通す。手数は少ないが、**誰も読まない
   テーブルに未使用のポリシーがインストールされた状態**が残る

**2 を採る場合は、その器が不活性であることを明示すること。** §4.2 で「ダミースキーマで
pgTAP を緑にするのは最悪手」と書いたのと同じ罠が、ここでも口を開けています ——
器があると、Storage の pgTAP が**何も守っていないのに通ってしまう**。

**publicのRLSとStorage非依存の関数・pgTAPを維持することが目標**です。
互換シム・所有者・権限・拡張を含む実DBの試験が通るまでは、無改変で動くと確定しません。
残りは Storage 側の事情で作り直しになります（§4.2）。
なお pgTAP は `supabase` CLI を起動せずローカルの Postgres コンテナで回せるようになり、CI は速くなります。

> **ただし公式の `postgres:17` イメージに pgTAP は入っていません。** 残すpgTAPも冒頭で
> `create extension pgtap` を実行するので、**素のイメージのままだと RLS のアサーションに入る前に落ちます。**
> pgTAP 入りのイメージを使うか、コンテナ起動時にインストールする手順を CI に足すこと
> （`extensions` スキーマを作るだけでは `pg_trgm` の話しか解決しません）。

> **`SET LOCAL` であることが重要です。** 接続プールで使い回すので、`SET`（セッション単位）だと
> 前のリクエストのユーザー権限が次のリクエストに漏れます。トランザクション外で DB に触る
> 経路を作らないこと、`withUser()` を迂回する生の `pool.query()` を書かないことを、
> lint ルールか `eslint-plugin-no-restricted-imports` で機械的に縛るべきです。

書き換えが要るのは **`supabase.from(...)` を呼んでいる箇所**（Server Action と Server Component の
データ取得）です。ここは素の SQL でも Kysely 等でも構いませんが、`withUser()` の外では
実行できない形にしておきます。

**`supabase.rpc(...)` の呼び出しも同じだけ書き換えが要ります。** 関数定義を DB に残すことと、
それを呼ぶ HTTP 経路（PostgREST）を残すことは別の話です。PostgREST を落とすと、
呼び出し元は**全て実行経路を失います**（`withUser()` 経由のパラメータ化した関数呼び出しへ移す）。
次の表は入口の例で、完了判定は `rg '\.rpc\(' src scripts` による全呼び出しの棚卸しで行います。

| 呼び出し元 | 関数 | 失われる機能 |
| --- | --- | --- |
| `src/app/onboarding/actions.ts:21` | `create_own_household` | 世帯未所属ユーザーのオンボーディング |
| `src/app/invite/actions.ts:15` | `accept_household_invite` | 内部/ゲスト招待の受諾 |
| `src/app/(app)/settings/page.tsx:63` | `get_household_members` | メンバー一覧の表示 |
| `src/app/(app)/settings/page.tsx:100` | `get_household_guests` | ゲスト一覧の表示 |
| `src/app/(app)/settings/actions.ts:391` | `delete_own_household` | 世帯の削除 |
| `src/lib/scheduleQuery.ts` / `src/app/(app)/schedule/actions.ts` | `schedule_rules_for_range` / `replace_schedule_rule` / `delete_plan` | 予定の展開・変更・見送り |
| `src/app/(app)/records/actions.ts` | `delete_record_keeping_skip` | 記録の削除後に予定を復活させない契約 |

これらのテストも併せて移します。

**アプリの外にも 1 つあります。** `scripts/feedback-to-issues.mjs` は
`supabase.auth.signInWithPassword()` でログインし、`.from("feedback")` で読み書きする
**保守用コマンド**です。Server Action でも Server Component でもないので上の棚卸しから漏れていました。
P5 で Supabase を止めた時点で**ご意見の棚卸しができなくなる**ので、Identity Platform 認証と
サーバー側の認可経由に書き換えるところまでを移行のスコープに入れます。

### 4.2 難所その2 — Storageの認可を何に置き換えるか

**Cloud Storage にはオブジェクト単位の宣言的ポリシーがありません。** Firebase の
Storage Rules はありますが、判定に「その世帯のメンバーか」を Postgres へ問い合わせることが
できないので、`{household_id}/{record_id}/{filename}` 規約の認可には使えません。

そこで **「RLS が返した行だけ署名する」** という形にします。認可の判断者は RLS のままです。

```mermaid
sequenceDiagram
  participant B as ブラウザ
  participant CR as Cloud Run
  participant DB as Cloud SQL
  participant GCS as Cloud Storage

  rect rgb(240,240,240)
  note over B,GCS: 表示 — RLS が返した行のパスだけを署名する
  B->>CR: 記録ページを要求
  CR->>DB: withUser: SELECT * FROM record_photos
  DB-->>CR: 見てよい行だけ（RLS が判定済み）
  CR->>CR: 返ってきた storage_path のみ V4 署名（1 時間）
  CR-->>B: HTML + 署名付き GET URL
  B->>GCS: 署名 URL で GET
  end

  rect rgb(240,240,240)
  note over B,GCS: アップロード — 発行前に世帯と編集権を確認する
  B->>CR: 署名アップロード URL をください（record_id, ファイル名）
  CR->>DB: withUser: 対象世帯で編集可能か
  DB-->>CR: 可
  CR->>CR: buildStoragePath で正規パス生成 → V4 署名 PUT（5 分）
  CR-->>B: 署名付き PUT URL（オブジェクト名と Content-Type を固定）
  B->>GCS: 画像本体を直接 PUT
  B->>CR: 完了通知 → record_photos に INSERT
  end
```

- バケットは **均一バケットレベルアクセス**＋**公開アクセス防止**を強制。匿名で読める経路をなくす
- **署名PUTで既存オブジェクトを上書きさせない。** 掃除と差し替えのために実行サービスアカウントへ
  削除権限を与えると、**GCS は同じ PUT URL での上書きも許します** —— 完了通知を処理して
  `record_photos` に行を作った**後で、同じ URL を投げ直して中身だけ差し替えられます**
  （認可も完了チェックも二度と通らない）。V4署名URLはXML APIを使うため、
  **`x-goog-if-generation-match: 0`ヘッダを署名とCORSへ含める**。JSON APIの`ifGenerationMatch`と混同しない。
  [公式のprecondition説明](https://docs.cloud.google.com/storage/docs/request-preconditions)のとおり、0は「現行オブジェクトが無い」条件であり、
  **1回限りのトークンではない**。削除後の再PUTは成立し得るため、完了予約・generationの固定・削除済みパスの掃除も必要
- 署名 URL は**オブジェクト名まで固定**して発行する。パスはクライアントの申告ではなく
  `buildStoragePath()` がサーバー側で組み立てる（`src/lib/storagePath.ts` はそのまま使える）
- **サイズ上限をサーバー側で縛る。** オブジェクト名と `Content-Type` だけ固定しても、
  **本文の大きさは実質無制限**です。`RecordForm` を経由せず発行済み URL を直接使えば、
  正規の editor（あるいは乗っ取られたセッション）が**巨大なオブジェクトを置いて
  ストレージ課金を膨らませられます**。[D20](./decisions.md) のクライアント側リサイズは
  帯域のための最適化であって**上限の強制ではありません**。署名前にサイズを検証し、
  **`Content-Length` を署名に束縛する**か、**サーバー側で最大値を強制するアップロードポリシー**を使うこと
- **発行そのものにも上限を置く。** 1 個あたりのサイズを縛っても、**URL を何本でも発行させれば
  総量は青天井**です（毎回ちがう UUID のパスになるので衝突もしない）。DB への insert を
  完了させなければ孤児掃除の猶予（24 時間）ぶんは残り続け、**予算アラートは「もう発生した課金」を
  止めません**。署名の発行口に**ユーザー / 世帯あたりのレート制限と、世帯あたりの総容量の上限**を付けること
- **署名アップロード要求には `household_id` を含め、その世帯を直接検証する。**
  上の図は「`record_id` とファイル名」と書きましたが、**新規作成ではそれだけでは世帯を決められません** ——
  `RecordForm` は `crypto.randomUUID()` で `record_id` をクライアント生成し、
  `daycare_records` の行ができる**前に**アップロードするからです（`RecordForm.tsx:71,163`）。
  かといって**「現在世帯」の Cookie で代用してはいけません** —— 複数世帯に属するユーザーが
  別タブで世帯を切り替えると、**画面 A の記録に世帯 B のパスを署名**してしまい、
  保存が落ちたうえに孤児オブジェクトが残ります（`CLAUDE.md` が名指しで警告している取り違え）。
  **新規は画面が描画された世帯 id を要求に載せてメンバーシップと編集権を検証し、
  既存記録への追加は対象行の `household_id` から導出する**、と分けます
- 署名は**サービスアカウント鍵ではなく IAM の `signBlob`** で行う。Cloud Run のサービス
  アカウントに自分自身への `roles/iam.serviceAccountTokenCreator` を与えれば、鍵ファイル無しで V4 署名できる。
  **`signBlob` だけでは足りません** —— 署名を作れるようになるだけで、**GCS は署名付きリクエストを
  そのサービスアカウントとして認可する**ので、バケットに対する `storage.objects.get`（読み）と
  `storage.objects.create`（アップロード）が無いと**発行した URL は全て 403 になります**。
  削除・掃除の経路にも対応する権限を、バケット単位の最小権限で付けること
- **バケットに CORS 設定を入れる。** 署名 V4 の PUT は GCS 側では通っても、`Content-Type` を
  付けるためブラウザが preflight（`OPTIONS`）を投げます。アプリのオリジン・`PUT`・
  必要なヘッダを許可しておかないと、**署名が正しくても全てのアップロードがブラウザで落ちます。**
  P2 のインフラ手順に必ず含めること
- **PUT だけ成功して INSERT が失敗した孤児オブジェクト**は必ず出るので、Cloud Scheduler +
  Cloud Run ジョブで日次掃除する。**掃除の対象は 2 バケット・参照元は 4 つ** ——
  写真は `record_photos`、アバターは `profiles.avatar_path` / `households.avatar_path` /
  `pets.avatar_path`。アバターにも PUT と DB 更新の間の窓があり（タブを閉じる・通信が切れる・
  Server Action が失敗する）、**写真だけを見る掃除では永久に拾われません**。

  **この掃除は `withUser()` では書けません。** バケット全体のオブジェクトを
  **全世帯の参照と突き合わせる**必要があるのに、`withUser()` が課す `authenticated` ＋ RLS では
  **他の世帯の行が見えない** —— つまり「参照されているのに見えない」オブジェクトを
  **孤児と誤判定して消してしまいます**（猶予 24 時間の後に、他人の写真が消える）。
  かといって migration 用アカウントで走らせると、§4.1 で分けた資格情報の分離が無意味になります。
  **掃除ジョブ専用のロールと、「このパスがどこかから参照されているか」だけを返す
  狭い SECURITY DEFINER 関数**を用意し、**別世帯のオブジェクトを消さないことを
  pgTAP か Integration のテストで固定すること。**
  **ただし「作成から一定時間（例: 24 時間）以上経過したもの」に限ること** —— 正常な
  アップロードでも PUT 成功から INSERT までには必ず間があり、その隙に掃除が走ると
  **INSERT は成功するのに実体が消えた行**ができます。
  **ただし「経過時間」だけでは閉じません** —— ブラウザが PUT 成功後にサスペンドされ、
  **24 時間より後に復帰して INSERT を完了する**ことがあり得ます（掃除はもう消している）。
  **署名を発行する時点で「予約」の行を作り、完了時にそれを消費する**形にし、
  あわせて、**完了時にオブジェクトの実在を確認**して、消えていたら参照を作らずに失敗させます。
  **予約には必ず期限を持たせること** —— 「予約のあるオブジェクトは掃除しない」とだけ決めると、
  **一番ありふれた失敗（PUT 成功後にブラウザが落ちて完了通知が来ない）で予約が残り続け、
  そのオブジェクトは永久に掃除対象外**になります（＝私的な写真と課金が消えずに積み上がる）。
  期限は署名 URL の有効期限 ＋ 猶予に合わせ、**期限切れの予約が付いたオブジェクトは掃除の対象**、
  **期限切れ後の完了通知は拒否**します

#### アバターのバケットも設計する

写真だけ設計して終わりにはできません。**private バケットは 2 つあります。**
`AvatarUploader` は `buildAvatarPath()` で `avatars` バケットへ直接上げており、
規約は `{scope_id}/avatars/{...}`、参照元テーブルは 3 つ（`profiles` / `households` / `pets`）ですが、
**`scope_id` は 2 通りしかありません** —— **ユーザーアバターは `owner_id`、世帯アバターと
ペットアバターはどちらも `household_id`** です（`20260706120000_avatars.sql` の
`avatars_{select,insert,delete}_scope`）。**ただし書込条件の最新版は#150の
`20261026143438_avatars_write_roles.sql`**です。旧ポリシーの単なるメンバー判定を署名発行へ移植しないこと。
写真用の「`record_id` を渡す」経路も
`buildStoragePath()` の規約もそのまま流用できません。

> **ペットの `scope_id` に `pet_id` を使ってはいけません。** 現状の更新経路は
> `isAvatarPathForScope(newPath, pet.household_id)`（`pets/actions.ts:127`）で
> **そのペットの所属世帯で始まるパスしか受け付けない**ので、`{pet_id}/avatars/...` に署名すると
> **GCS への PUT だけ先に成功し、そのあと Server Action がパスを弾いて**
> ペットのアバター更新が必ず壊れます。ペット用の発行口は**対象のペット行を引いて、
> その `household_id` でパスを組む**こと。

したがって **P2 では署名 URL の発行口を「操作」ごとに分けて用意します。**
パスのスコープが同じ `household_id` でも、**操作によって必要な role が違う**からです
（世帯アバターとペットアバターで違います）。

> **ここに「操作 → 必要な role」の対応表は置きません。** `CLAUDE.md` が
> 「ここに対応表を持つとコードと二重管理になり、**実際にこの表は 2 度間違えた**（D16）」と
> 名指しで警告しているとおりで、**一度書いた表を消しました**（3 度目をやりかけました）。
> **正は `src/app/(app)/settings/actions.ts` と `src/app/(app)/pets/actions.ts` の
> 各アクションです。** 実装時はそこを読んで、**その操作が実際に要求している role を
> そのまま署名の条件にする**こと。表を写すと、権限が変わったときに
> **署名だけが広いまま取り残されます。**

**「世帯のメンバーか」だけで署名すると、本来 owner だけの操作を viewer に許すことになります。**
そのあと DB 更新の側で弾かれるとしても、**不正なオブジェクトとその課金はもう発生しています。**
発行口は**対象の行を引いて、その操作に必要な role を確かめてから**署名すること。判定は写真と同じく
「RLS が返したか」に寄せ、**差し替え時の旧オブジェクト削除**（いま
`settings/actions.ts` と `pets/actions.ts` が `remove()` でやっていること）も
サーバー側の削除経路として作り直します。ここを P2 のスコープに入れ忘れると、
アバターの表示・変更・削除が丸ごと壊れます。

#### `delete_own_household` は書き直しになる

Storage依存のある関数です。最新版は `20260810000000_schedule.sql` の
`delete_own_household` は `storage.objects` を直接引き、`storage.foldername(o.name)[1]` で
**その世帯の写真が残っている間は削除を拒否する**ガードを持っています。
Supabase Storage のスキーマが無くなればこの関数は**インストールすら失敗**し、
空の互換テーブルを置けば**ガードが常に素通りして、実体の残った GCS オブジェクトを
置き去りに世帯とメンバーシップだけが消えます**（どちらも許容できない）。

**GCS のプレフィックス確認は、認可済みの削除フロー側（Server Action）へ移します。**
DB 側の関数からは Storage 依存のガードを外し、「オブジェクトが残っていないこと」の
確認と実削除はアプリが行う、という分担にします。

**ただし「プレフィックスが空か見る」だけでは競合します。** 5 分有効の署名 PUT URL を先に
受け取っておけば、削除処理が空を確認 → 世帯とメンバーシップを削除 → **その後で PUT が成功**
という順序が起こり得ます。**GCS は署名の発行時にしか認可を見ないので、いまの Storage RLS の
ように「書き込みの瞬間にメンバーシップを再評価する」ことをしてくれません。** 手順はこうします。

1. 世帯を「削除中」に印を付ける
2. **その印を、署名の発行だけでなく世帯スコープの更新系すべてに効かせる** ——
   止めるのが署名だけだと、待っている 24 時間のあいだに**ペット・記録・招待・メンバーが
   普通に増やせます**。すると掃除ジョブは「空にならない」まま延々と失敗するか、
   カスケードで消す作りにした場合は**「削除は保留中」と言われた後に作ったものまで消します**。
   削除が完了するかキャンセルされるまで、**その世帯への書き込みは一律で拒否**すること
3. **その世帯の予約が全て決着する（消費されるか期限切れになる）まで待つ** ——
   **これはリクエストの中では待てません。** 予約の期限は署名 URL の有効期限 ＋ 猶予
   （24 時間規模）なので、Server Action を開いたままにはできない。**「削除中」を
   DB に永続化し、続きは Cloud Scheduler で動く後片付けジョブに引き継ぐ**こと
   （利用者には「削除を受け付けました」を即返す）
4. プレフィックスが空であることを確認し、実体を消してから世帯を削除する
5. **そのプレフィックスを「削除済み」として記録に残し、掃除のジョブが以後も
   繰り返し掃く**。単に一定期間空だったという理由で記録を落とさない

> **時刻を基準にした「待ち」では、この競合は原理的に閉じません。**
> 期限の直前に始まって**本文の送信中に停滞している PUT は、期限を過ぎても打ち切られず**、
> **アップロード中のオブジェクトは完了するまで一覧に現れない**ので、
> **何度確認しても、その瞬間はプレフィックスが空に見えます。**
> 予約に期限を付けても「予約は期限切れ、PUT はまだ飛んでいる」状態を作れるだけで、
> **安全な打ち切り点は存在しません。**
>
> **なので「1 回確認して終わり」をやめます。** 削除した世帯のプレフィックスを
> **tombstone（削除済みの印）として残し、掃除のジョブが以後も繰り返しそのプレフィックスを
> 掃く**ようにします。**遅延PUTを捕捉できることを実証するまではtombstoneを保持します。**
> より確実にするなら、**予約の消し込みを時刻ではなく GCS のオブジェクト確定通知
> （Pub/Sub の finalize イベント）で行う** —— 実際に「置かれた」ことを signal にすれば、
> 遅れて届いた PUT も必ず掃除の対象に入ります。

#### Storage非依存のpgTAPを残し、Storageの担保を移す

2026-10-26時点のpgTAPは10ファイルあり、全てを無改変で移せるとは限りません。`storage.` を参照しているのは 4 ファイルで、
Storage スキーマの無い素の Postgres では**そのまま落ちます**。
互換用のダミースキーマを置いて緑にするのは**最悪手**です —— 新しい GCS 認可を
何も検証しないまま「テストは通っている」ように見えるからです（V4: 壊れても緑に見える）。

| pgTAP ファイル | `storage.` 参照 | 移行後 |
| --- | --- | --- |
| `guest_grants_test` / `guest_invites_test` / `household_invites_test` / `household_provisioning_test` / `household_rls_test` / `schedule_test` | 0 | **認可アサーションを維持**。bootstrap・role・extensionを互換DBで検証 |
| `household_delete_test` | 1 | Storage ガードの分だけ剥がす |
| `household_rbac_test` | 5 | Storage 部分を剥がす |
| `household_storage_tags_test` | 21 | Storage 部分は削除し、tags 部分だけ残す |
| `avatars_test` | あり | **Storage認可とパスの試験を移す**。#150で追加したviewer拒否も対象 |

剥がした分の担保は **Integration 層（Vitest + 実 DB + fake-gcs-server）へ移します** ——
「どのスコープなら署名 URL が発行されるか / されないか」を検証する層です。
[D30](./decisions.md) の割り当て原則（その層でしか捕まらないものを置く）に従うと、
アプリ層の認可判断は元々 Integration の担当なので、位置としても正しい移動になります。
**この移し替えを P2 の完了条件に含めること。**
ただしエミュレータの成功は本番IAM・signBlob・CORS・署名ヘッダ・generation条件の成立を証明しません。
使い捨てオブジェクトを用いた実GCSの契約試験も別に通し、他世帯・viewer・期限切れゲスト・
改変したパス／サイズ／ヘッダ・上書き・削除後の再PUT・完了前後の競合を確認します。

**これは `CLAUDE.md` の記述を変える変更です。** 「一次防衛線は RLS」は DB については変わりませんが、
**Storage については「アプリ層の認可 ＋ 短命の署名 URL」に変わります。**
移行時にセキュリティ節を書き換えてください（黙って変えると、次のセッションのエージェントが
古い前提で Storage を触ります）。

代わりに得るものもあります。**オブジェクトのバージョニングとソフト削除**を有効にすれば、
D22 が「写真の事故からは戻せないことを許容」と書いた穴が埋まります。

> **ただしバージョニングは保持期間とセットで有効にすること。** アバターの差し替え・写真の
> 上書き・削除はいずれも**旧世代（noncurrent generation）を残し、消すまで課金され続けます**。
> ソフト削除の保持期間はこの旧世代を縛りません。**保持期間を決めて Object Lifecycle
> Management で消す**ルールを同時に入れないと、§6 の保存容量の仮定を超え、
> さらに**削除したはずの私的な写真が意図より長く残ります**（後者のほうが問題です）。

### 4.3 難所その半分 — 認証と、Google Drive の refresh token

利用者から見て一番リスクが高いのは「ログインできなくなる」ことです。ここは
**UID を保ったまま移す**ことで、ほぼ無傷にできます。

- Supabase の `auth.users` **と `auth.identities`** を書き出し、**`uid` を指定したまま**
  Identity Platform へ一括インポートする。**`auth.users` だけでは Google の provider subject が
  保存されません** —— 「同じメールなら自動で紐づく」に頼ると、同一メール衝突時の挙動が
  設定依存なので、**初回ログインで別 UID が発行されたり「アカウントが既に存在します」で弾かれたり**
  します。そうなると、**インポート済みだが誰もログインできない UID に、全ての外部キーと
  世帯メンバーシップがぶら下がった状態**になります。`providerData` ごと入れ、
  **Google の初回ログインをリハーサルしてから** UID 保存を確定と見なすこと。
- **`banned_until` が入っているユーザーは、無効化した状態でインポートすること。**
  UID・ハッシュ・identity・検証状態だけを写すと、**Identity Platform 側では既定で有効な
  アカウント**になります。つまり **BAN したはずの人が P4 を境にログインでき、
  UID に紐づいたままの世帯メンバーシップとゲスト付与を取り戻します。**
  **BAN されたユーザーがログインできないこともリハーサルの確認項目に入れる**
  パスワードは bcrypt ハッシュのまま持ち込めるので、**パスワード再設定は不要**。
  ただし **インポート時に `BCRYPT` を明示する**こと（アルゴリズムの宣言は必要）。
  **コスト（ラウンド数）は指定しません** —— bcrypt はハッシュ文字列自体に
  コストが埋まっているので、SDK 側にラウンド数を渡す設定は無く、
  **渡そうとすると不正な設定になります**（ラウンド数の指定が要るのは別のハッシュ方式）。
  **email/password でのログインは必ずリハーサルに含める**
- UID が変わらないので、各テーブルの `owner_id` / `user_id` は**一切書き換え不要**
- **「同一メールなら自動で 1 アカウントに統合される」という既存の契約を維持すること。**
  [identity-linking.md](./identity-linking.md) は、Google と email/password のどちらで入っても
  同じ人物・同じ世帯メンバーシップになることを **Supabase の自動リンクに委ねる**と決めています
  （手動リンクは意図的に閉じている）。ここで効くのは**インポートに無いプロバイダを
  初めて使ったとき**です —— 例えば email/password だけのユーザーが P4 後に初めて Google で
  入ろうとすると、**`auth.identities` に Google の subject が無い**ので、
  Identity Platform の「同一メールの扱い」設定次第で**衝突として弾かれるか、
  別アカウントが作られます**。後者だと**自分の世帯が消えたように見えます。**
  **同一メール統合の設定を明示的に合わせ、認証済みの状態から資格情報を紐づける導線**を
  用意すること（インポートとリハーサルだけでは足りません）
- **`emailVerified` は全ユーザーぶん、Supabase の確認状態（`email_confirmed_at`）から写すこと。**
  Google のユーザーだけ立てて済ませると、**bcrypt を持ち込んだ email/password ユーザーが
  未確認扱いのまま**になります。§4.1 で「claims の `email` は検証済みのものだけ」と決めた以上、
  この人たちは **`email` claim を失って `invites_select_invitee` に当たらず、
  自分宛ての招待を受諾できません。** 逆に未確認のまま claim に入れれば、§4.1 の
  セキュリティ要件そのものを破ります。**email/password ユーザーでの招待受諾もリハーサルに含めること**
- セッションは Cookie（`__Host-session`）。Firebase Admin SDK の `createSessionCookie` で発行し、
  `src/middleware.ts` で検証する。**`src/middleware.ts` に Node ランタイムを明示すること** ——
  コンテナを Cloud Run で動かしても **Next.js の middleware は既定で Edge ランタイムのまま**で、
  Firebase Admin のセッション Cookie API は Node の API を要求します。明示しないと
  **P4 で全リクエストが落ちます**（明示せずに済ませたいなら、検証を middleware から出す）
- **更新（ローテーション）の経路も決めること。** セッション Cookie は
  **その場で延長できず、寿命の上限も 2 週間**です。発行と検証だけ決めて更新を決めないと、
  **2 週間ごとに全員が強制ログアウト**になり、「移行時に 1 度だけ再ログイン」という
  説明が嘘になります（家族向けアプリで一番効く不便です）。
  **クライアントで取り直した ID トークンを使って、CSRF 対策付きで Cookie を再発行する**
  流れを設計に含めるか、**「N 週間ごとに再ログインが要る」と明示して受け入れる**か、
  どちらかを決めておくこと
- **Cookie の属性は自分で付けること。** `createSessionCookie` が返すのは**文字列だけ**で、
  Admin SDK は HTTP レスポンスの属性を設定してくれません。**`__Host-` 接頭辞は
  `Secure` ＋ `Path=/` ＋ `Domain` 無しでないとブラウザに拒否される**ので、
  付け忘れると**全員がログインできません**。また **`HttpOnly` を落とすと、
  長命の認証セッションが JavaScript から読めます**。
  `HttpOnly` / `Secure` / `SameSite` / `Path=/` / Domain なし / 有効期限、を
  セッションの契約として最初に決めること
- **セッション Cookie の検証は失効を見に行くものにすること。** 署名だけを見る検証だと、
  **パスワードをリセットしても、アカウントを無効化しても、リフレッシュトークンを失効させても、
  発行済みの Cookie は期限まで通り続けます** —— つまり「乗っ取られたので止める」操作が
  実際には止まりません。`verifySessionCookie(cookie, true)` のように失効を確認するか、
  Cookie を短命にして再検証する方式を決めること（毎リクエスト失効確認するとネットワーク往復が
  増えるので、**更新系と設定変更では必ず確認・閲覧のみは短命 Cookie で妥協**、のような
  切り分けを設計時に決めます）
- **セッション Cookie を発行するエンドポイントは、ログイン CSRF に対して閉じること。**
  任意の有効な ID トークンを受け付ける実装だと、**攻撃者が自分のトークンを被害者のブラウザから
  送り込んで被害者のセッションを差し替えられます**（被害者は気づかないまま攻撃者のアカウントへ
  記録や写真を書き込むことになる）。POST を発行元のブラウザに束縛する CSRF トークンを要求し、
  `createSessionCookie` を呼ぶ前に **`auth_time` が十分新しいこと**を確認します
- **認証切替時に全員が再ログインします。** P1のorigin変更やCookie更新方針による再ログインも別に考慮し、1回だけと保証しません

> **書き出しから切替までの間、アカウント系の操作を止めること。** §7.1 で書いた凍結は
> **P4 より後**の話で、**その手前の競合を塞いでいませんでした。** `auth.users` を書き出してから
> Identity Platform が正になるまでの間にパスワードを変えた人は**古いハッシュのまま持ち込まれ**、
> その間に登録した人は**そもそも入っていません**。どちらも切替後にログインできず、
> 「1 度だけ再ログインすれば済む」は成立しません。**書き出し〜切替の窓では、新規登録・
> パスワード変更・リセット・メール変更を凍結する**か、**差分を切替まで継続同期する**こと。

> **UID を保てるのは「移行してくる既存ユーザー」だけです。** P4 以降に新規登録する人には
> Identity Platform が**独自形式の不透明な UID**を振ります。一方 `auth.users.id` も
> 各テーブルの `owner_id` / `user_id` も `auth.uid()` の契約も **`uuid` 型**なので、
> **新規ユーザーは互換テーブルに入らず `/onboarding` を完了できません。**
> どちらかを決めること —— **(a) サーバー側のプロビジョニング経路で UUID を採番し、
> それを UID に指定してアカウントを作る**（Admin SDK は UID 指定で作成できる）か、
> **(b) 外部 UID → 内部 UUID の対応表を持ち、RLS の claim には内部 UUID を入れる**。
> **(a) のほうが `auth.uid()` の契約に手を入れずに済みます** —— **ただし (a) だけでは
> Google ログインを塞げません。** フェデレーションの初回サインインでは、**アプリが何かを
> 呼ぶ前に Identity Platform 側でアカウントと UID が作られます**。つまり (a) が効くのは
> 「アプリが主導する登録」だけで、**Google の新規ユーザーは相変わらず UUID でない UID を
> 持って `/onboarding` に来ます。** したがって実際には
> **フェデレーション経路には (b)（外部 UID → 内部 UUID の対応表）が必須**か、
> **サーバー主導の OAuth ＋ カスタムトークンで発行を握る**かのどちらかになります。
> **「(a) を既定に」ではなく「(a) ＋ フェデレーションには (b)」が正しい形です。**

> **P4 の作業は `src/middleware.ts` だけでは終わりません。** リポジトリには
> **`.auth.*` の呼び出しが複数箇所**あります。内訳は「セッション確認」（`getUser()` が大半で、
> Server Component と Server Action の冒頭に散っている）と「認証操作そのもの」
> —— `signUp` / `signInWithPassword` / `signInWithOAuth` / `updateUser({ password })` /
> `resetPasswordForEmail` / `signOut` / `exchangeCodeForSession`。
> **`__Host-session` を発行・検証できるようにしただけでは、これらは古いプロバイダを見続けます。**
> P5 で Supabase を止めた時点で、認証済みのページと更新系が**壊れるか、より悪いことに
> 古いプロバイダを信頼し続けます。** P4 の完了条件に **全呼び出しの棚卸しと置き換え**を含めること。

**見落としやすい罠が 1 つあります。** `google_credentials` の refresh token です。
今は Supabase の Google OAuth が `provider_refresh_token` を返してくれるので
`/auth/callback` で保存できていますが（`src/lib/google/token.ts`）、
**Identity Platform のログインは Drive スコープの offline refresh token を返しません。**

したがって **Drive 連携はログインとは別の OAuth フローに分離**します。
「ログイン」＝ Identity Platform、「Drive 連携」＝ アプリ自身の OAuth 同意画面
（`google-auth-library` で `access_type=offline`）という 2 本立てです。
**この新しいフローには、セッションに束縛した使い捨ての `state` を必ず付けること。**
`state` を検証しないと、**攻撃者が自分の Google アカウントに対する認可を開始し、
被害者のブラウザでコールバックを踏ませて、被害者の `google_credentials` 行に
攻撃者の refresh token を保存させられます**。以後 Drive 書き出しを使うたびに、
**被害者の記録が攻撃者の Drive へ入ります。** `state` は発行時にセッションへ紐づけ、
**コードを交換する前に検証**すること（1 回限りで使い捨て）。

暗号化保存の仕組み（`src/lib/google/crypto.ts`）と `google_credentials` テーブルはそのまま使えます。
既存ユーザーの refresh token は Supabase の OAuth クライアントに紐づくため、
**クライアントを変えるなら Drive 連携だけは再同意が必要**です。

---

## 5. CI/CD と環境（検討当時の案）

```mermaid
flowchart TB
  PR["Pull Request"] --> CI["CI: lint / typecheck / unit / build<br/>pgTAP は pgTAP 入りの Postgres イメージ<br/>E2E は docker compose"]
  CI -->|"緑"| M["main へマージ"]
  M --> WIF["Workload Identity 連携<br/>サービスアカウント鍵なし"]
  WIF --> AR["Artifact Registry<br/>イメージを push"]
  AR --> JOB["Cloud Run ジョブ<br/>migration 適用"]
  JOB -->|"成功"| DEP["Cloud Run に新リビジョン<br/>--no-traffic でデプロイ"]
  DEP --> T["トラフィックを 100% 切替"]
  JOB -.->|"失敗"| STOP["デプロイ中止<br/>現行リビジョンのまま"]
  T -.->|"問題発生"| RB["前リビジョンへ即時ロールバック"]
```

いまの `deploy-production.yml` の骨格（**CI が緑のときだけ migration → デプロイ**）は
そのまま持ち込めます。変わるのは中身です。

| いま | 移行後 |
| --- | --- |
| `supabase db push` | migration 適用専用の **Cloud Run ジョブ**（アプリと同じイメージ・同じ VPC）。**イメージに migration 一式と実行スクリプトを明示的に入れること** —— `.next/standalone` はアプリの実行に要るものしか含まないので、`supabase/migrations` もベースラインも**入りません**。入れ忘れると**適用するものが無いままジョブが失敗し、全てのデプロイが止まります** |
| デプロイ前に `pg_dump` を暗号化してArtifactへ保存（#150）。写真・authは別途保護が必要 | **Cloud SQL の自動バックアップ ＋ PITR（7 日）**。加えてデプロイ直前にオンデマンドバックアップ |
| `vercel deploy --prebuilt --prod` | `gcloud run deploy --no-traffic` → `--to-latest` |
| 失敗したら Artifact から手で復元 | `gcloud run services update-traffic --to-revisions=前リビジョン=100`（数十秒）。**ただし下記の条件つき** |
| ローカルは `supabase start` | `docker compose`（postgres + Auth エミュレータ + fake-gcs-server） |
| CI で `supabase/setup-cli` を固定バージョン取得 | 不要になる（GitHub API のレートリミットで CI が落ちる問題も消える） |

`ci.yml` に昇格権限を足さない制約（`deploy-production.yml` からの `workflow_call` 再利用）は
そのまま守ります。WIF の権限はデプロイ側のワークフローにだけ持たせます。

> **「前リビジョンへ戻せる」は無条件ではありません。** migration はトラフィック切替の**前**に
> 適用されるので、その migration が**前リビジョンのイメージが使っている列・関数・契約を
> 壊していると、リビジョンを戻すコマンドは成功するのにアプリは動きません**（DB はもう新しい形）。
> デプロイ直前のバックアップは即時の戻し先にはならず、復元すれば切替後の書き込みも消えます。
> したがって **migration は expand / contract で書き、ロールバック窓が閉じるまで新旧どちらの
> リビジョンでも動く形を保つ**ことを規約にします（列は「足す → 使う → 消す」を別リリースに割る）。
> これを守らないリリースをするときは、**リビジョンのロールバックが効かないことを承知のうえで
> DB 復元を含む手順を先に決めてから**出すこと。

**環境は 2 つに増やせます。** Supabase Free は「active 2 プロジェクト」の制約があり
[D22](./decisions.md) は preview 用の別プロジェクトを断念していますが、Cloud SQL なら
同一インスタンス内に staging データベースを作るだけで済みます（追加費用ほぼゼロ）。
Cloud Run のリビジョンタグでプレビュー URL も出せます。
**ただし接続数はインスタンス単位で共有される**ので、staging のスケール上限も
§6.2 の予算に含めること（含めないと staging の E2E が本番を落とします）。

---

## 6. 費用と予算（2026-10-28 JPY公開SKU照合、東京）

月3,000円は承認された上限目標で、課金を停止する上限ではありません。共有コアの制約を受け入れて費用を抑えます。
**約2,400〜2,700円という旧USD仮換算だけで現在の全体費用を判断しません。** 以下は長期コミットなしの公開JPY単価に税10%を仮置きした31日見積です。

| 項目 | 前提 | 税込概算 |
| --- | --- | ---: |
| Cloud SQL | db-f1-micro×744h、SSD10GiB、保存backup総量10GiB | 2,363円/月 |
| 付帯サービスと予備 | GCS保存10GiB/配信5GiB/操作、AR1GiB、Secret10versions/1,000access、Run送信1GiB、その他税別100円。Run計算無料枠利用可 | 411円/月 |
| 復元検証の予備 | 24時間の追加検証instance等を月1回と仮定。実際の方式・時間・保持量で変動 | 76円/月 |
| **合計** | Run 1CPU/1GiB、月3万request×2秒を共有無料枠内、IdP少人数のGoogle/email、SMSなし | **約2,851円/月** |
| Run無料枠を利用できない場合 | 同じ負荷で計算・request分を約277円追加 | **約3,128円/月** |

合計は丸め前の約2,363.05＋411.39＋76.23＝2,850.67円から算出しています。
無料枠を使えない場合は約277.01円を加え、3,127.68円です。単発の性能smokeから月間使用量は推定しません。
税別単価の例はmicro 2.20073円/時、SSD 34.740095円/GiB月、backup 16.34828円/GiB月です。
[Cloud Billing Catalog](https://docs.cloud.google.com/billing/v1/how-tos/catalog-api)のJPY SKUで確認しており、USDを任意の為替で再換算していません。
[Cloud SQL](https://cloud.google.com/sql/pricing/)、[Cloud Run](https://cloud.google.com/run/pricing)、
[Storage](https://cloud.google.com/storage/pricing)、[Identity Platform](https://cloud.google.com/identity-platform/pricing)、
[Artifact Registry](https://cloud.google.com/artifact-registry/pricing)、[Secret Manager](https://cloud.google.com/secret-manager/pricing)の正価・適用税・実使用量が優先します。
無料枠は請求アカウント内で共有され、東京GCSを米国限定の保存無料枠に含めません。

backupの10GiBは全保存量の仮定であり、日次14件の各backupが10GiBという意味でも、保存量の上限でもありません。
実容量が小さければ費用は減りますが、復元品質のための保持世代を予算だけで削りません。
SSDは安全容量のため最大20GiBへ自動増設でき、縮小は自動で戻りません。20GiBになればこの見積を更新します。
無期限手動backup、ARの複数image、Secret version、GCS soft delete、通信、build・移行二重稼働を月次確認します。
初回移行の一時費用、HA、専有コア、ALB/NAT/connector、別SMTP、ドメインは上表に含めません。

**共有コアはGoogle公式でテスト・開発向け、本番非推奨、SLA対象外です。** 単一ゾーンには障害時の自動failoverがありません。
[公式instance設定](https://docs.cloud.google.com/sql/docs/postgres/instance-settings)を踏まえ、少人数の性能実測と復旧手段を条件に採用しています。
メモリ不足・接続枯渇・遅延が出たら3,000円内で維持できると決めつけず、構成と予算を再判断します。
GenAI用途限定クレジットと期限切れFree Trialは一般インフラ費用から差し引きません。個人の残高・請求先IDは記載しません。

### 6.1 P0 / P1からの費用制御（計画時の段階条件）

- Cloud SQLはP3の検証準備が整うまで作成しない。P0 / P1は既存Supabaseを使い、まず配信だけを評価する。
- Cloud Runは最小0・最大1・リクエスト課金を初期値とする。最大値はデプロイ時等の一時的超過があり得るため、課金上限とは扱わない。
- P1ではVPCコネクターやCloud NATを追加しない。後にDirect VPC egressを使う場合もprivate-ranges-onlyを基本にし、外部OAuthへの通信経路を確認する。
- Artifact Registryの古いイメージにcleanup policyを設定する。稼働中・直前のロールバック用イメージは保持する。
- 月3,000円で50% / 90% / 100%の予算アラートを設定する。[予算は支出を自動で止めない](https://docs.cloud.google.com/billing/docs/how-to/budgets)ため、超過通知時は未使用リビジョン・検証資源・通信量を確認する。DBやバックアップを自動削除して費用を止める仕組みにはしない。
- P2では署名発行の回数・容量制限、旧世代のLifecycleとsoft delete保持期間を同時に設定する。画像や動画の増加は人数だけでは予測できないため、保存量と外向き通信量を観測する。

### 6.2 安い機種を選ぶなら、接続数の予算も決める

**共有コアの Cloud SQL は同時接続数の上限が小さい**一方、**Cloud Run はインスタンスを
いくらでも増やせ**、`pg` のプールは 1 インスタンスあたり複数本張ります。放っておくと、
**CPU もリクエスト枠も余っているのに接続だけが枯れて、Server Component も Server Action も
全部落ちる**という壊れ方をします。安い機種を選ぶことと、**Cloud Run の最大インスタンス数と
1 インスタンスあたりのプールサイズを決めること**はセットです。

`最大インスタンス数 × プールサイズ ＋ 予備` が上限に収まるように決め、
**migration ジョブと運用（`psql` での調査）のぶんを必ず予備として残す**こと ——
障害調査のときに繋げないのが一番困ります。

**staging を同じインスタンスに置くなら、その接続も同じ予算に入れること。**
§5 で「同一インスタンス内に staging データベースを作るだけ」と書きましたが、
**接続数はデータベース単位ではなくインスタンス単位**です。staging のプレビューや E2E が走ると、
**本番と同じ小さな枠を奪い合い、staging のテストが本番を落とし得ます**。
staging 側にもスケール上限を課して同じ計算に含めるか、**別インスタンスに分ける**
（そのぶん費用が増える）かを決めること。

**必ず予算アラートを設定してください**（月 ¥3,000 で 50% / 90% / 100% 通知）。
Supabase Free と違い、GCP は上限に当たって止まるのではなく課金され続けます。
これは移行で新たに増えるリスクで、金額そのものより性質が変わる点が重要です。

---

## 7. 移行計画 — 準備と5段階（検討当時の案）

一気に切り替えないこと。**各フェーズの終わりで本番が動いていて、前のフェーズへ戻せる**
順序にしてあります。難所（DB）を真ん中に置き、利用者影響のある認証を後ろに寄せています。

```mermaid
flowchart LR
  P0["P0 土台<br/>プロジェクト / VPC / WIF<br/>Terraform<br/>本番影響なし"]
  P1["P1 配信<br/>Cloud Runの別URLで検証<br/>公開先を段階切替<br/>旧配信を保持"]
  P2["P2 ファイル<br/>Storage → GCS<br/>署名 URL 方式へ<br/>読みは両対応で並走"]
  P3["P3 データベース<br/>→ Cloud SQL + auth シム<br/>停止時間は復元試験で決定"]
  P4["P4 認証<br/>→ Identity Platform<br/>全員が 1 度再ログイン"]
  P5["P5 撤収<br/>Vercel / Supabase 停止<br/>監視・バックアップ運用開始"]
  P0 --> P1 --> P2 --> P3 --> P4 --> P5
```

| | やること | 戻し方 |
| --- | --- | --- |
| **P0** | 予算・API・Artifact Registry・実行用SAとデプロイ用SAの分離・WIF・必要なSecretを準備。IaCまたは再実行可能な手順をレビューし、本番はVercel + Supabaseのまま。Cloud SQL等の後段資源はまだ作らない | 既存本番は変更しない。未使用の検証資源だけを片付ける |
| **P1** | `output: "standalone"`、コンテナ起動CI、初期はIAM認証が必要なCloud Runの検証URL。**DB・Auth・StorageはSupabaseのまま**。検証成功後に公開入口を切り替える | 旧Vercel配信を維持。入口を旧URLへ戻す。独自ドメインを使う場合はDNSのTTLも考慮 |
| **P2** | GCS バケット作成、`rclone` で既存オブジェクトを同期（Supabase Storage は S3 互換なのでそのまま繋がる）、署名 URL 方式へ実装変更、**読み取りは一定期間 GCS 優先・無ければ Supabase にフォールバック**（下記のとおり存在確認が要る）、差分再同期 | **GCS にしかないオブジェクトを Supabase へ書き戻してから**リビジョンを戻す（下記） |
| **P3** | `auth` 互換シムを**プレマイグレーション**として整備、`withUser()` とデータアクセス層の書き換え、pgTAP をローカル Postgres で緑にする。**本番は読み取り専用にして、絞り込んだデータだけを Cloud SQL へ移す → 接続先切替**（下記）。ここだけ停止が要る | **書き込みを再度止め、Cloud SQL の差分を Supabase へ逆同期してから**接続先を戻す（下記） |
| **P4** | Identity Platform 設定、UID 保存の一括インポート、`.auth.*` の全呼び出しの置き換え、セッション Cookie 実装、Drive 用 OAuth の分離、`auth.users` 同期 | **パスワード変更・リセットに加え、新規登録とプロバイダでの初回ログインも凍結したうえで**（凍結しないと IdP にしか存在しないアカウントが締め出される）ID プロバイダを Supabase Auth に戻す（§7.1） |
| **P5** | **旧経路のアップロードを塞ぎ、最後の差分同期と2バケットの突き合わせを終えてから**旧配信・Supabaseを段階的に停止。削除は復元と保管期間を確認して別途判断。予算・監視・復元はP0から整備し、ここまで後回しにしない | 削除前は検証済みの逆同期手順を使う |

### 7.0 P0 / P1の完了条件

P0 / P1はインフラの準備と配信の検証です。**この段階でRLS・UID・Storage認可を置き換えません**。
初期Cloud RunはIAM認証必須のprivate検証とし、検証者の認証付き呼び出しで疎通します。公開ログインの試験とは区別します。
旧配信と同じ本番SupabaseへつなぐCloud Runはテスト用データベースではなく、そこでの書き込みも本番操作です。
匿名疎通とコンテナ検証を先に行い、認証付きの動作確認は専用データと確認範囲を決めてから実施します。

1. **ビルド再現性**: Node 22とlockfileの`npm ci`、lint / typecheck / unit / build、linux/amd64コンテナの起動を確認する。
   `PORT`に従い`0.0.0.0`で待ち受け、public・`.next/static`・standalone成果物・非root実行を確認する。
   CIのplaceholderイメージと、本番公開値をbuild時に入れた配信用イメージを区別する。実envファイルや秘密値をbuild context / ARG / imageへ入れない。
2. **配信と認証の接続**: `/login`・静的アセット・manifest・SWを検証し、Supabaseの許可redirectに新originを追加する。
   現行コードは`window.location.origin`から`/auth/callback`を作るため、許可URLの漏れはログインを壊す。
   GoogleプロバイダがSupabaseのcallbackを使う間は、そのURLを無断でCloud Runへ置き換えない。
   callback後のscheme / hostが外部のHTTPS originであることもリバースプロキシ越しに確認する。
3. **公開入口**: `vercel.app`から`run.app`へ変わる場合は別originであり、Cookie・localStorage・SW・インストール済みPWAは引き継がれない。
   再ログインとホーム画面への再追加を確認し、旧URLを急に削除しない。独自ドメインは方式・追加料金・証明書を別途検証する。
4. **権限と課金**: デプロイSAと実行SAを分離し、WIFはリポジトリID・所有者IDと許可したref / environmentに絞る。
   PRやforkから本番SAを利用できないことを確認する。長期JSON鍵を作らず、実行SAへ不要なSQL管理・広域Storage・Secret全読取を付けない。
   最小0 / 最大1 / リクエスト課金・予算通知・イメージ保持方針を確認する。
5. **公開と戻し方**: 新revisionは検証後にtrafficを切り替え、稼働revisionとimage digestを記録する。
   未認証の利用者がログイン画面へ到達できる公開設定と、アプリ内の認証・認可を別に検証する。
   DB変更のないP1では旧Vercelが同じSupabaseを使える状態を維持し、旧公開入口へ戻せることを確認する。

P2以降は、署名URL・UID対応・RLS互換・復元の自動テストと各段階の停止／逆同期手順が完了条件です。
P0 / P1の成功を、DBと認証を移してよい根拠として流用しません。

> **「本番を読み取り専用にする」をアプリ側の状態で済ませないこと。**
> P3 の時点では**認証がまだ Supabase**にあり、**PostgREST の口も開いたまま**です。
> Cloud Run の画面を読み取り専用にしても、**有効な JWT を持つブラウザは API へ直接
> 書き込めます**（既存の `authenticated` ポリシーが許す範囲で）。
> スナップショットを取った後にコミットされた書き込みは **Cloud SQL に存在しないまま
> 切り替わり、静かに失われます。** **Supabase 側で書き込み権限を落とす**（ロールの権限を
> 剥がす／API の口を閉じる）ところまでやり、**進行中のトランザクションが終わるのを待って**
> から最終コピーを取ること。

> **P3 の移送は「`pg_dump` して `pg_restore`」ではありません。**
> 既定の全体ダンプには **Supabase の `auth` / `storage` スキーマ・関数・GRANT・所有者情報**が
> 丸ごと入ります。移送先には**別物の `auth` シム**が先に入っていて **`storage` は意図的に
> 無い**ので、そのまま流すと**シムと衝突する**か、**ベースラインで捨てたはずの
> Storage のオブジェクトとポリシーを呼び戻します**。
> 移すのは **① 互換テーブル用の `auth.users` 相当の行 → ② `public` のテーブルデータ**の
> 2 段階だけで、**スキーマはベースライン済みのものを使う**（＝データだけを、順序を決めて入れる）。

**P3 の前に、本番データのコピーで復元リハーサルを 1 回通してください。**
絞り込んだ移送、pgTAP 緑、アプリ起動、写真表示まで。
ここを踏まずに当日やると、停止時間が読めません。

> **P2 の「GCS 優先・無ければ Supabase」は、署名するだけでは実装できません。**
> **署名 URL は存在しないオブジェクトに対しても生成できる**ので、保存されたパスを機械的に
> 署名した時点で「GCS にある」と決めつけたことになり、フォールバックは永久に発火しません。
> これは初回同期の後も起きます —— 古いバンドルを掴んだままのタブやインストール済み PWA が
> **Supabase にだけ**新しいオブジェクトを上げつつ `record_photos` の行は普通に作るので、
> 新しい画面はもっともらしい GCS の URL を返して **404 になり、Supabase には辿り着きません。**
> **署名の前に GCS のメタデータで存在確認をする**か、**両方の URL を返してクライアント側で
> エラー時に切り替える**かのどちらかにし、**「混在した状態」を P2 の Integration テストに含めること。**

> **P1 の「無停止・DNS 戻しで即復旧」も、証明書の分だけ甘い見積もりでした。**
> Cloud Run のドメインマッピングは、**そのドメインの DNS が Cloud Run を向いてからでないと
> マネージド証明書の発行が完了しません**。発行には DNS 反映よりずっと長くかかることがあり、
> **その間、既存ホスト名への HTTPS が失敗し得ます。** 戻すときも、前の応答を掴んだクライアントの
> TTL 分は戻りません。**証明書を先に検証できる切替方法を採る**か、**想定の停止時間と
> TTL ぶんのロールバック窓を先に決めて告知する**かのどちらかにします。

### 7.1 ロールバックは「接続先を戻すだけ」では済まない

上の表の「戻し方」は、**切替直後（まだ 1 件も書き込みが起きていない時点）でしか成立しません。**
ここを楽観していたので、明示的に直しておきます。

**P2 —— 新しい写真とアバターは GCS にしかありません。**
読み取りのフォールバックを逆向きにするだけで済むのは、**ハイブリッド版のコードが本番に載っている間だけ**です。
コードごとロールバックする事故では、Supabase しか見ない旧レンダラーが**新しい写真を表示できません。**
ロールバック窓の間は**アップロードを両方へミラーする**か、**書き込みを止めて GCS の差分を
Supabase の 2 バケットへ書き戻してから**リビジョンを戻すこと。

**そして「増えたものを書き戻す」だけでは足りません —— 削除も伝える必要があります。**
ハイブリッド期間に写真やアバターを**削除・差し替え**すると、新しい経路は GCS からは消しますが
**Supabase 側のコピーは残ったまま**です。増分だけを書き戻してロールバックすると、
**利用者が消したはずの私的な写真が、既知の Storage パスで再び読めるようになります**
（消えるより悪い種類の事故です）。**削除も両方へミラーする**か、
**削除したパスの一覧（tombstone）を持って、戻す前に突き合わせる**こと。

**P3 —— サービス再開後に書かれたものは Cloud SQL にしかありません。**
読み取り専用にするのは初回ダンプと切替の間だけなので、Cloud SQL で動き始めた瞬間から
新しい記録・編集は Cloud SQL 側にだけ積まれます。この状態で単に接続先を Supabase へ戻すと、
**その間の記録が消えます。**ロールバック手順は必ずこうします。

1. 書き込みを**再度**止める（メンテナンスモード）
2. Cloud SQL の内容を Supabase へ**逆方向に反映**する
3. 反映の完了を確認してから接続先を戻す

**手順 2 を「`pg_dump --data-only` ＋ 突き合わせ」と書いていたのは誤りでした。**
data-only のダンプは**実質 INSERT の羅列**なので、中身の入った Supabase へ流せば
**主キーで衝突し**、しかも**「消された行」を表現できません**。切替後に編集や削除が
1 件でもあれば、これでは戻せません。採れるのは次のいずれかです。

- **全テーブルの入れ替え**（この規模での既定）—— FK の順序どおりに truncate → 再投入し、
  シーケンスを合わせる。家族数人ぶんのデータ量なら数分で終わり、**差分を考えなくてよいぶん確実**。
  **ただし手順として書き、リハーサルで一度通しておくこと**（FK の順序を外すと途中で止まります）
- **「切替から N 時間を過ぎたら前に進むだけ」と決める** —— 逆同期を用意せず、
  問題は Cloud SQL 側で直す。**一番安いが、後戻りできないことを受け入れる**選択

> **「論理レプリケーションで戻す」案は取り下げました。** §3.2 で
> **Cloud SQL に Public IP を持たせない**と決めているのに、この案では
> **Supabase 側が購読者として Cloud SQL へ接続しにくる**必要があり、**到達経路がありません。**
> 自分で書いた 2 つの決めが噛み合っていませんでした。到達経路をわざわざ用意すれば
> できますが、**「インターネットから DB に届く経路を作らない」という一番効いている
> セキュリティ上の決めを、ロールバックのために緩めることになります。** 割に合いません。

どちらを採るかは **P3 の実施前に決め、選んだものはリハーサルに含めること。**

**P4 —— 認証は「戻せば元通り」ではありません。**
P4 が動き始めると、パスワード変更・パスワードリセットは **Identity Platform 側だけ**を
更新します。同期は `auth.users` を Cloud SQL へ写すだけで、**Supabase の GoTrue には何も戻しません。**
この間にパスワードを変えた利用者がいる状態で Supabase Auth へ戻すと、**古い資格情報が復活し、
本人がログインできなくなります。**ロールバック時は、
**パスワード変更・リセットを凍結する**か、**新しい資格情報を GoTrue へ書き戻す逆手順を用意する**
かのどちらかが要ります。実務的には、**P4 の切替直後 24 時間はパスワード変更系の導線を
一時的に閉じておく**のが一番安く済みます。

**ただし閉じるのはパスワード変更だけでは足りません。** その 24 時間に **Google で初めて
ログインした人や新規登録した人は、Identity Platform にしか存在しません**。同期は
Cloud SQL の `auth.users` へ写すだけで **GoTrue には作らない**ので、認証を Supabase へ戻すと
**その人たちはログインできなくなり、しかもアプリ側の行は新しい UID で作られたまま残ります。**
ロールバック窓の間は **新規登録と「プロバイダでの初回ログイン」も止める**か、
**戻す前に新規アカウントを GoTrue 側へ作り直す**こと。

### 7.2 P5 で止める前に、旧経路の書き込みを枯らす

P5 を「後片付け」と考えていましたが、**ここにも取り返しのつかない失敗が 1 つあります。**

§4.2 に書いたとおり、**古いバンドルを掴んだままのタブやインストール済み PWA は、
Supabase にだけオブジェクトを上げつつ、DB の行は（Cloud SQL に）普通に作ります。**
これが **P2 の最後の再同期より後**に起きると、そのオブジェクトは
**GCS には無いまま参照だけが正規に存在する**状態になります。この状態で Supabase を
一時停止すれば**その写真は 404 になり、プロジェクトを削除すれば永久に失われます。**

したがって P5 の順序はこうします。

1. **旧経路のアップロードを塞ぐ**（Service Worker とバンドルの更新を強制する、
   もしくは旧経路の書き込みをサーバー側で拒否する）
2. フォールバック読み取りは**まだ生かしたまま**、最後の差分同期を実行する
3. **2 バケットを突き合わせて差分ゼロを確認する**
4. そこで初めて Supabase を一時停止する（**削除はさらに 1 か月後**）

### 7.3 P3 と P4 の「間」で `auth.users` が古いまま止まる

ロールバックとは別に、フェーズの**隙間**にも穴がありました。
**`auth.users` の同期を P4 の作業として書いていましたが、それでは遅すぎます。**

P3 が終わった時点で DB は Cloud SQL、**認証はまだ Supabase** です。この間に新規登録した人
（あるいは初めてログインした人）は **Supabase Auth にしか存在せず**、Cloud SQL の
`auth.users` はダンプ時点のスナップショットのまま止まっています。各テーブルの外部キーの
参照先がその表である以上、**その人は `/onboarding` に案内されたうえで
`create_own_household` が失敗します**（UID が Cloud SQL に無いため）。しかも
**「世帯未所属で `/onboarding` に来るのは正常」なので、故障が正常系に見えて原因が分かりにくい。**

**対応は 2 つのどちらか。P3 の作業として決めること。**

- **サインイン時に Supabase のユーザーを Cloud SQL の `auth.users` へ upsert する**（推奨。
  P4 の同期処理を前倒しで作るだけなので、捨てる実装にならない）
- **P4まで新規登録を認証プロバイダ側で凍結する**。`SIGNUP_ENABLED=false`は現在の画面側フラグで、
  公開Auth APIやGoogle初回サインインの停止にはならない。直接APIからの登録も拒否されることを試験する。
  既存ユーザーのログインや招待を継続できるかも確認する

---

## 8. 移行で得るもの・失うもの

| | |
| --- | --- |
| **得る** | 自動バックアップと PITR（D22 の「唯一のロールバック資産」問題が解消） |
| | 写真の世代管理・ソフト削除（D22 が許容していた「写真は戻せない」が解消） |
| | staging 環境が持てる（D22 が Free 枠の制約で断念したもの） |
| | DB が Private IP に閉じる（インターネットからの到達経路が消える） |
| | 認証・DB・ファイル・配信・CI の権限が IAM 1 か所に集約される |
| | CI から `supabase` CLI が消える（レートリミット由来の CI 落ちが消える） |
| **失う** | **月 ¥0**（D18 の前提） |
| | Supabase Studio 相当の管理 UI（`psql` と Cloud Console になる） |
| | Storage の宣言的な行レベルポリシー（アプリ層の認可に移る = 4.2） |
| | ブラウザから DB を直接叩ける手軽さ（Server Action 一本になる） |
| | 「上限に当たったら止まる」性質（従量課金。予算通知は停止機能の代替ではない） |

---

## 9. 検討当時の未決事項（現在の判断は冒頭を参照）

1. **公開URLと切替時期。** 月額おおむね3,000円で移行する判断はD38で済んでいます。P1の検証結果と利用者影響を見て本番入口を決めます
2. **Sentry を残すか。** ブラウザ側の JS エラーは Cloud Error Reporting では拾えないので、
   サーバー = Cloud Logging / Error Reporting、クライアント = Sentry の併用を推します。
   「全部 GCP」に厳密に寄せるなら、クライアントエラーは自前の `/api/vitals` 相当に送る形になります
3. **データアクセス層に何を使うか**（素の `pg` / Kysely / Drizzle）。`withUser()` を迂回できない
   形にできればどれでも構いません
4. **Drive 連携の再同意を求めるか**（OAuth クライアントを変えるかどうか、§4.3）

---

## 参照

- 現行構成: [reference/architecture.md](../reference/architecture.md)
- 現行のデプロイ手順: [guides/deploy.md](../guides/deploy.md)
- 関係する決定: [decisions.md](./decisions.md) の D18（無料枠）・D20（クライアント側リサイズ）・
  D22（デプロイとバックアップ）・D23（Service Worker のキャッシュ禁止）・D30（テスト 4 層）
