# Google Cloud 移行の技術選定

[gcp-migration.md](./gcp-migration.md) が「どう移すか」なら、こちらは **「なぜその部品なのか」**です。
移行案の §2 では 3 案を並べただけだったので、**評価観点を外部の枠組みから引いて、
レイヤごとに候補を出し直し、重み付きで採点し直しました。**

結論から言うと、**採点は最初の 3 案の順位を変えませんでしたが、有力な対抗馬が 1 つ増えました**
（配信層の Firebase App Hosting）。それと、**「GCP に無料の Postgres は無い」は不正確**でした
（条件付きで存在します。§5 の案 F）。

---

## 1. 評価観点をどこから採ったか

自分の頭で観点を作ると、都合のいい観点しか並びません。3 つの外部の枠組みと、
このリポジトリ固有の制約から引きました。

| 出典 | そこから採った観点 |
| --- | --- |
| [Google Cloud Well-Architected Framework](https://docs.cloud.google.com/architecture/framework)（6 本柱） | 運用の卓越性 / セキュリティ・プライバシー・コンプライアンス / 信頼性 / コスト最適化 / パフォーマンス最適化 / サステナビリティ |
| 技術選定フレームワーク一般（[MCDA・AHP の解説](https://www.emergentmind.com/topics/technology-selection-frameworks)、[ADR の実務](https://medium.com/@ggonchar/a-simple-framework-for-architectural-decisions-c365b6907b47)） | 性能・非機能（拡張性 / 保守性 / セキュリティ）・**TCO**・**成熟度**・コミュニティ・互換性。**観点に重みを付けて採点し、ADR に残す**という手順そのもの |
| ロックイン / 出口戦略（[ISC2 の Cloud Exit Strategies](https://www.isc2.org/Insights/2024/04/Cloud-Exit-Strategies-Avoiding-Vendor-Lock-in)、[Journal of Cloud Computing のロックイン分析](https://link.springer.com/article/10.1186/s13677-016-0054-z)） | **データ / プラットフォーム / 契約 / 運用モデルの 4 層**でロックインを見る。**再設計工数・データ移送コスト・ダウンタイムリスクを含む「出口テスト」** |
| このリポジトリの決定（[decisions.md](./decisions.md)） | D18 無料枠と運用対象の最小化 / D22 バックアップとデプロイ経路 / D30 テスト 4 層 / RLS が一次防衛線 |

サステナビリティは**評価から外しました**。家族数人・インスタンス 1 個未満の規模では
どの案を選んでも差が測定できず、載せると「観点を網羅した感」だけが出るためです（[D16](./decisions.md) の精神）。

## 2. 重み — 汎用の重みをそのまま使わない

Well-Architected の 6 本柱は等価ではありません。**このアプリで実際に効く順**に重みを置きます。

| 観点 | 重み | なぜその重みか |
| --- | --- | --- |
| **テナント分離・セキュリティ** | **25%** | 入っているのは家族の日々の記録と子ども（ペット）の写真。**漏れることの被害が、落ちることの被害より明確に大きい。** 現に一次防衛線を RLS に置き、pgTAP で CI に縛っている |
| **移行コストと可逆性** | **20%** | 出口テストの観点。**戻れない移行は、失敗したときに失敗のままになる** |
| **運用負荷** | **20%** | 開発も運用も 1 人。**最も希少な資源は金でも CPU でもなく人の時間**で、D18 が「運用対象を増やさない」と書いているのはこれ |
| **金銭コスト（TCO）** | **15%** | D18 の中心。ただし**額そのものより「上限で止まる」か「使った分だけ請求される」かの性質**が重要。**GCP はどの案でも後者**（案 F を含む。§5） |
| **信頼性（復旧できること）** | **10%** | 可用性より**復旧可能性**。数分落ちても誰も困らないが、記録が消えると取り返しがつかない |
| **性能・体感** | **10%** | スマホの PWA なので初回表示の体感だけが実質の指標。スループットは論点にならない |

**さらに 3 つの足切り（満たさない案は総合点に関わらず不採用）** を置きます。
重み付き合計は「1 つの観点の壊滅を他で埋められてしまう」ので、そこだけは合計に混ぜません。

1. **テナント分離が自動テストで守られていること**（今 pgTAP が担保しているもの）
2. **1 人で運用しきれること**
3. **ロールバックできる資産があること**（D22 が唯一の資産だと書いたもの）

---

## 3. レイヤごとの候補と評価

### 3.1 配信

| 候補 | 評価 |
| --- | --- |
| **Cloud Run** ★採用 | コンテナのまま動き、スケール 0、VPC 直接エグレスで Cloud SQL の Private IP に届く。**Google 自身が App Engine より先にこれを勧めている**（[App Engine 比較](https://docs.cloud.google.com/appengine/migration-center/run/compare-gae-with-run)）。設定の自由度が最大 |
| **Firebase App Hosting** ◎対抗 | **SSR フレームワーク専用の上物で、CDN・ビルド・GitHub 連携が最初から付く**（[製品比較](https://firebase.google.com/docs/app-hosting/product-comparison)）。Next.js には最も素直。**ただし D22 と衝突する** —— D22 は「Vercel の Git 連携自動デプロイを却下し、Actions に一本化」と決めており、App Hosting の中心的な価値はまさにその Git 連携。**採るなら D22 を覆す決断とセット**。Cloud SQL の Private IP 接続まわりは要検証 |
| App Engine Standard | 却下。Google が新規は Cloud Run を勧めており、機能的に上位互換 |
| GKE Autopilot | 却下。ノード管理は減るがクラスタという運用対象が増える。運用負荷 20% の観点で論外 |
| Compute Engine | 単体では却下（§5 案 F で全部載せとして再評価） |

**Cloud Run を推しますが、App Hosting は本当に僅差です。** 分けたのは
「D22 を覆すか」という**技術ではない論点**で、そこは判断してもらう必要があります（§6）。

### 3.2 データベース

| 候補 | 評価 |
| --- | --- |
| **Cloud SQL for PostgreSQL** ★採用 | RLS・`pg_trgm`・SECURITY DEFINER がそのまま動く唯一の現実解。共有コアで**月 $7〜10**（[Cloud SQL 価格](https://cloud.google.com/sql/pricing)、[実勢の比較](https://www.bytebase.com/dbcost/cloudsql-pricing/)）。**Postgres なので出口が広い**のがロックイン観点で効く |
| AlloyDB | 却下。「印象がいいからという理由で AlloyDB や Spanner を選ぶな、追加コストと複雑さは実際にその能力が要るときだけ正当化される」——[選定ガイドの一般論](https://oneuptime.com/blog/post/2026-02-17-how-to-choose-between-cloud-sql-cloud-spanner-and-alloydb-for-your-database-workload/view)がそのまま当てはまる |
| Spanner | 却下。グローバル分散も無制限の水平スケールも要らない |
| Firestore | **単体では却下**（§5 案 A で全面移行として再評価）。SQL の結合と `pg_trgm` の部分一致検索、そして 90 本の RLS を失う |
| **Firebase SQL Connect**（旧 Data Connect） | **保留 —— 面白いが今回は見送り。** Cloud SQL の Postgres を裏に置き、`@auth` ディレクティブ付きの GraphQL でブラウザから直接叩ける（[製品](https://firebase.google.com/products/sql-connect)、[管理](https://firebase.google.com/docs/data-connect/manage-services-and-databases)）。**PostgREST を失う穴を公式に埋める唯一の候補**で、[ネイティブ SQL も書ける](https://firebase.blog/posts/2026/03/fdc-native-sql)。ただし **`@auth` は行レベルではなくコネクタ単位の認可**で、既存の RLS がどう噛むかは**実機検証が要る**。コスト下限は Cloud SQL と同じ（同じインスタンスが要る）ので、**安くはならず、検証コストだけ増える**。将来 PostgREST 相当が欲しくなったら再評価する |
| GCE 上の自前 Postgres | §5 案 F で評価 |

### 3.3 認証

| 候補 | 評価 |
| --- | --- |
| **Identity Platform / Firebase Auth** ★採用 | Google と email/password の両方。**50,000 MAU まで無料**（[価格](https://cloud.google.com/identity-platform/pricing)）で、家族数人では永久に無料枠。**UID を保った一括インポートができる**ことが決め手 |
| GoTrue を自前ホスト | 却下。運用対象が増える（案 C と同じ理由） |
| Identity-Aware Proxy | 却下。社内アプリ向けで、招待・世帯・ゲストという本アプリの認可モデルに合わない |

> **SMS / 電話認証だけは無料枠の外**です（[Firebase Auth の費用解説](https://www.metacto.com/blogs/the-complete-guide-to-firebase-auth-costs-setup-integration-and-maintenance)）。本アプリでは使わないので影響しませんが、**将来 2 要素認証を足すときにここで課金が始まります。**

### 3.4 ファイル

| 候補 | 評価 |
| --- | --- |
| **Cloud Storage ＋ サーバー発行の V4 署名 URL** ★採用 | 判断者を RLS に寄せたまま実装できる唯一の形（移行案 §4.2） |
| Cloud Storage ＋ Firebase Storage Rules | 却下。**Rules から Postgres に「その世帯のメンバーか」を問い合わせられない**。世帯・ゲスト権限の判定に使えない |
| Cloud Run を経由してストリーム | 却下。Cloud Run に転送とメモリを払わせるうえ、直接アップロードの利点（D20 の経緯）を捨てることになる |

### 3.5 CI / CD

| 候補 | 評価 |
| --- | --- |
| **GitHub Actions ＋ Workload Identity 連携** ★採用 | 既存のワークフロー資産（CI の 4 ゲート・pgTAP・E2E）をそのまま使え、**サービスアカウント鍵をどこにも置かない** |
| Cloud Build | 却下。GitHub Actions と二重になる。移行の途中で CI を差し替えるのは変更を 2 つ同時に走らせることになる |
| Cloud Deploy | 却下。段階的リリースの管理は要るほど複雑ではない |

---

## 4. 全体案の採点

レイヤの選択を組み合わせた 6 案を、§2 の重みで採点しました（各観点 1〜5）。

| | セキュリティ<br>25% | 移行/可逆<br>20% | 運用<br>20% | 金銭<br>15% | 信頼性<br>10% | 性能<br>10% | **加重** | 足切り |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **B. Cloud Run + Cloud SQL + IdP + GCS** | 4 | 4 | 3 | 2 | 5 | 4 | **72** | 通過 |
| **D. App Hosting + Cloud SQL + IdP + GCS** | 4 | 3 | 4 | 2 | 5 | 5 | **74** | 通過 |
| A. Firestore 全面 | 3 | 1 | 5 | 5 | 4 | 4 | **70** | **① で落ちる** |
| E. SQL Connect + Cloud SQL | 3 | 2 | 3 | 2 | 5 | 4 | **59** | 通過 |
| C. Supabase OSS 自前ホスト | 3 | 5 | 1 | 1 | 3 | 3 | **54** | **② で落ちる** |
| F. GCE 1 台に全部載せ | 3 | 3 | 1 | 4 | 1 | 2 | **50** | **②③ で落ちる** |

**合計点だけ見ると A（Firestore）が B に肉薄します。** 運用と金銭で満点を取るからです。
これが足切りを別に置いた理由で、**A の「移行/可逆 = 1」は他で埋められる種類の弱点ではありません** ——
90 本のポリシーと 9 本の pgTAP を捨てて Security Rules を書き直すのは、
**移行ではなく作り直し**で、しかも Firestore からの出口は Postgres より明確に狭い。

---

## 5. 見落としていたこと 2 つ

### 「GCP に無料の Postgres は無い」は不正確だった —— ただし案 F も ¥0 ではない

案 F を真面目に検討して分かりました。**Always Free の e2-micro が 1 台あります。**
ただし **us-west1 / us-central1 / us-east1 限定**で、Asia を選んだ時点で普通に課金されます
（[Always Free の条件](https://agentdeals.dev/gcp-free-tier-2026)）。

**そして、この案を「月 ¥0」と書いたのは私の誤りでした。** PWA を配信するには
**外部から到達できるアドレスが要りますが、使用中の外部 IPv4 アドレスは Always Free の
対象外で別途課金されます。** 額としては小さい（月数百円）ものの、
**「¥0 だから選ぶ」という案 F の唯一の存在理由に直接効きます。**

したがって案 F の正しい姿は **「月 ¥0」ではなく「月数百円 ＋ 日本から往復 100ms 超 ＋
単一 VM ＋ バックアップ自作 ＋ OS のパッチも自分」** です。
**Cloud SQL 案との差は月 ¥1,800 ではなく、¥1,300〜1,500 程度に縮みます。**
金銭コストを人の時間と信頼性で買う取引としては、**当初の見立てよりさらに割の悪い取引**です。
それでも「できるだけ安く」が最優先なら選択肢ではあるので、机の上には載せておきます。

### 配信層に本命がもう 1 つあった

Firebase App Hosting です（§3.1）。**採点では B をわずかに上回ります** ——
CDN が最初から付くぶん性能で勝ち、ビルドとデプロイの面倒を見てくれるぶん運用でも勝つからです。
それでも B を推すのは、**D22 を覆さずに済む**ことと、**Cloud SQL の Private IP 接続や
VPC まわりで Cloud Run のほうが確実**だからで、**技術的な優劣ではありません。**

---

## 6. 結論と、決めてほしいこと

**採点は最初の結論（案 B）を覆しませんでした。** 足切りを通過し、
セキュリティと可逆性で最も高く、弱点（金銭・運用）は予算アラートと Terraform で管理可能な範囲です。

ただし、選定の過程で**技術では決められない分岐が 2 つ**あることがはっきりしました。

1. **配信は Cloud Run か Firebase App Hosting か** —— 採点上は App Hosting が僅差で上。
   分岐しているのは「[D22](./decisions.md)（デプロイ経路を Actions に一本化し、Git 連携の自動デプロイを却下）を
   覆すか」という**方針の問題**です。覆さないなら Cloud Run、CDN とビルドの手間削減を取るなら App Hosting。
2. **できるだけ安くを最優先にするか** —— するなら案 F（US リージョンの単一 VM）ですが、
   **これも ¥0 ではありません**（外部 IPv4 が Always Free の対象外）。差は月 ¥1,300〜1,500 程度で、
   その差額で**自動バックアップ・PITR・東京リージョン・OS を触らなくてよいこと**を買うかどうか、という問いになります。

なお **Firebase SQL Connect は「今は見送り、将来再評価」** として記録します。
ブラウザから DB を直接叩く経路が恋しくなったときの第一候補です。

---

## 参照

このページで参照した外部資料。

- [Google Cloud Well-Architected Framework](https://docs.cloud.google.com/architecture/framework) — 6 本柱
- [技術選定フレームワークと MCDA / AHP](https://www.emergentmind.com/topics/technology-selection-frameworks)
- [アーキテクチャ決定の進め方（ADR）](https://medium.com/@ggonchar/a-simple-framework-for-architectural-decisions-c365b6907b47)
- [Cloud Exit Strategies: Why and How to Avoid Vendor Lock-in（ISC2）](https://www.isc2.org/Insights/2024/04/Cloud-Exit-Strategies-Avoiding-Vendor-Lock-in)
- [Critical analysis of vendor lock-in（Journal of Cloud Computing）](https://link.springer.com/article/10.1186/s13677-016-0054-z)
- [App Engine と Cloud Run の比較（Google）](https://docs.cloud.google.com/appengine/migration-center/run/compare-gae-with-run)
- [Firebase App Hosting と他サービスの比較（Google）](https://firebase.google.com/docs/app-hosting/product-comparison)
- [Cloud SQL / Spanner / AlloyDB の選び方](https://oneuptime.com/blog/post/2026-02-17-how-to-choose-between-cloud-sql-cloud-spanner-and-alloydb-for-your-database-workload/view)
- [Cloud SQL 価格（Google）](https://cloud.google.com/sql/pricing) ／ [機種別の実勢価格](https://www.bytebase.com/dbcost/cloudsql-pricing/)
- [Identity Platform 価格（Google）](https://cloud.google.com/identity-platform/pricing) ／ [Firebase Auth の費用解説](https://www.metacto.com/blogs/the-complete-guide-to-firebase-auth-costs-setup-integration-and-maintenance)
- [Firebase SQL Connect](https://firebase.google.com/products/sql-connect) ／ [サービスとデータベースの管理](https://firebase.google.com/docs/data-connect/manage-services-and-databases)
- [GCP Always Free の実際の条件](https://agentdeals.dev/gcp-free-tier-2026)
