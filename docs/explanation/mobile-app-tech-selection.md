# Android / iOS アプリ化の技術選定

> 「mfmf を Android アプリ・iOS アプリとして使えるようにしたい」に対する技術選定の記録。
> **[D18](./decisions.md) で一度「ネイティブアプリ化を却下」している**ので、この文書はその再検討でもある。
> 結論だけ要る人は [§5 結論](#5-結論) へ。判断基準（Values）は [principles.md](./principles.md)。

---

## 1. 前提：いま何を持っているか

選定の重みはここで決まるので、先に**動かせない事実**を測っておく。

| 項目 | 実測値 | 選定への効き方 |
| --- | --- | --- |
| ソース規模 | `src/` 102 ファイル / 11,705 行（TypeScript strict） | 書き直し案のコストの分母 |
| 画面数 | `page.tsx` 25 枚（App Router、原則 Server Component） | 同上 |
| **Server Action** | **8 ファイル / 30 関数**（`records` `pets` `settings` `feedback` `onboarding` `guest` `invite`） | **静的エクスポート系の案で全部作り直しになる最大の障害** |
| Client Component | 30 ファイル | そのまま持ち込める部分 |
| Route Handler / middleware | `auth/callback` `auth/signout` `api/vitals` ＋ `src/middleware.ts`（Cookie セッション更新） | 認証モデルの移植ポイント |
| DB | migration 32 本、RLS ＋ pgTAP でテナント分離を担保 | **バックエンドは案によらず変わらない**（＝差が出るのはクライアント側だけ） |
| テスト基盤 | Playwright E2E 13 spec ＋ VRT（D25 / D30 / D31） | ブラウザ前提。**web UI を残す限り失効はしない**が、ネイティブ UI には一切届かないので**別系統の追加**が要る |
| 運用制約 | Vercel Hobby ＋ Supabase Free の**無料枠で完結**（D18） | 金銭コストの許容度が低い |
| **通知** | **未実装。** `public/sw.js` のリスナは `install` / `activate` / `fetch` の 3 つだけで、`PushManager` の購読・許可フロー・VAPID・送信側のいずれも存在しない | **どの案でも「通知」は新規実装**。案の優劣ではなく共通コストなので、比較では「実装した先に何が届くか」だけを見る |
| 利用者 | 家族数人（ストアでの発見・獲得は価値ゼロ） | 「ストア公開」自体が目的になっていないか要確認 |

**すでに満たしていること**と**まだ無いもの**を分けておく。現状の PWA で、iOS / Android とも
**ホーム画面インストール・スタンドアロン起動・オフライン表示**は動く。
一方**通知は動いていない** —— プラットフォーム側の前提（iOS 16.4+ の Web Push、Android は以前から）は
揃っているが、**アプリ側が未実装**なので「既にある機能」として案 A に加点してはいけない。
つまり検討対象は「アプリ化で**増える**もの」と「どの案でも等しく払う通知の実装コスト」の 2 つに分かれる。

---

## 2. 評価観点（web 調査で収集）

web から集めた観点を、この プロジェクトの事情で重み付けしたもの。重みの合計は 100。
「なぜその重みか」を書いていない観点は、選定の根拠にならないので載せていない。

| # | 観点 | 重み | 何を見るか | なぜこの重みか |
| --- | --- | --- | --- | --- |
| **C1** | **ストア審査を通過できるか** | 15 | Apple ガイドライン **4.2（Minimum Functionality）**／Play の TWA 要件（Digital Asset Links・Lighthouse 80）／Play の**新規個人アカウント 12 テスター × 14 日**ルール | 通らない案は他がどれだけ良くても成立しない（**足切り観点**） |
| **C2** | **既存資産の再利用率（書き直し量）** | 20 | Server Action 30 本・25 画面・TS 型・Supabase クライアントがどれだけ生き残るか | 11.7k 行を捨てる案は、家族向けアプリの投資対効果に合わない |
| **C3** | **継続運用コスト（手間）** | 20 | ストア審査の列・署名鍵の管理・年次のポリシー対応・SDK 強制アップデート・ビルド系統の本数 | **V1 / D18 の核**。「運用対象を増やさない」がこのプロジェクトの一貫した判断 |
| **C4** | **金銭コスト** | 10 | Apple Developer Program **$99/年**、Google Play **$25 買い切り**、EAS 等の CI 課金 | D18 の「無料枠で完結」を崩す。ただし額としては小さいので重みは中 |
| **C5** | **得られるネイティブ機能** | 15 | プッシュの確実性・カメラ・共有シート受け取り・バックグラウンド処理・生体認証・ウィジェット | 「今できないこと」が増えないなら、そもそもアプリ化する意味がない |
| **C6** | **既存 CI / テスト基盤との整合** | 10 | Playwright の E2E（D25）・VRT（D31）・スクリーンショット生成（D26）が**そのまま使えるか / 別系統を足すことになるか** | D25〜D31 で積んだ基盤。**テスト系統が 2 本になると品質ゲートの維持コストが倍**になる |
| **C7** | **セキュリティモデルとの整合** | 10 | Cookie セッション（`@supabase/ssr`）・OAuth リダイレクト・**アプリ層の認可をどこで持つか**・リモートコード実行の有無 | RLS は一次防衛線であって唯一の防衛線ではない。**アプリ層の認可ヘルパー（D16）を置く場所が消える案は減点**（Edge Function に持たせれば維持できる） |

> 観点の出典は [§6 参考にした情報](#6-参考にした情報)。
> 「オフライン」「パフォーマンス」は候補間の差が小さい（どの案も WebView か RN で、
> Supabase 往復が支配的）ので独立観点にせず C5 に畳んだ。

---

## 3. 候補（7 案）

| 案 | 概要 | ストアに出るもの |
| --- | --- | --- |
| **A** | **現状維持＋ PWA インストール導線の強化**（A2HS 案内、iOS 26 のホーム画面既定 web app、Web Push） | 出ない |
| **B** | **TWA（Bubblewrap / PWABuilder）で Android のみ Play 公開**、iOS は PWA のまま | Android のみ |
| **C** | **Capacitor ＋ 静的エクスポート**（`output: 'export'`。Server Action 30 本をクライアント直 Supabase / Edge Function へ移す） | Android ＋ iOS |
| **D** | **Capacitor ＋ `server.url`**（WebView が本番 URL を読むだけの薄いラッパー） | Android ＋ iOS |
| **E** | **Expo / React Native で書き直し**（Supabase バックエンドは共有、UI は RN） | Android ＋ iOS |
| **F** | **Flutter で書き直し** | Android ＋ iOS |
| **G** | **Swift / Kotlin でフルネイティブ**（2 コードベース） | Android ＋ iOS |

---

## 4. 評価

### 4-1. 足切り（C1）

**D は失格。** Capacitor の `server.url` は Ionic 自身が「**開発用（live-reload）であって本番用ではない**」と明言しており、
本番利用は**リジェクトにつながりうる**とされている。加えて、
(1) Apple 4.2 から見れば「URL を読むだけの汎用コンテナ」＝典型的な *lazy wrapper* で、
オフライン時にホワイトアウトする挙動まで含めて狙い撃ちされる類型、
(2) web バンドルを更新するとネイティブ側の**プラグイン版とズレて壊れる**、という既知の運用事故がある。
C2（書き直しゼロ）だけは満点だが、**通らない案に他の点数は意味がない**ので以降は比較から外す。

**B と C は条件付きで通せる。** B は Digital Asset Links と Lighthouse 80 を満たせば Play 側は素直に通る。
C は「ネイティブ要素（プッシュ・カメラ・オフライン処理・ネイティブナビ）を実装していれば通る」——
逆に言えば、**C は 4.2 を通すためだけにネイティブ機能の実装が必須**であり、それが C5 の得点と C2 の失点の両方を生む。

**B の落とし穴は Apple ではなく Google 側にある。** 2023-11-13 以降に作られた**個人**開発者アカウントは、
production 公開の前に**クローズドテストで 12 人以上を 14 日間連続でオプトイン**させる必要がある
（法人＝ D-U-N-S 登録済みアカウントは免除）。**家族数人のアプリで 12 人は集まらない。**
→ **production 公開を諦め、Play の internal testing トラック（最大 100 名、12 人ルールの対象外）で配る**のが現実解。
iOS 側も同じ発想で **TestFlight の internal tester（最大 100 名、審査なしで即配布）** が使える。
**「ストアに並べる」ことと「iOS/Android アプリとして家族に配る」ことは別問題**で、
後者だけが目的なら**審査（C1）は回避できる**——ただし TestFlight ビルドは **90 日で期限切れ**になるため、
**四半期ごとの再アップロードという恒久的な運用（C3）と引き換え**になる。

### 4-2. スコア（5 点満点 × 重み、100 点換算）

| 観点（重み） | **A** PWA 継続 | **B** TWA(Android) | **C** Capacitor+静的 | **E** Expo/RN | **F** Flutter | **G** ネイティブ | ~~D~~ 失格 |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| C1 審査 (15) | 5 | 4 | 4 | 5 | 5 | 5 | **1** |
| C2 再利用 (20) | 5 | 5 | 2 | 2 | 1 | 1 | 5 |
| C3 運用手間 (20) | 5 | 3 | 2 | 1 | 1 | 1 | 3 |
| C4 金銭 (10) | 5 | 4 | 3 | 3 | 3 | 3 | 3 |
| C5 ネイティブ機能 (15) | 2 | 3 | 5 | 5 | 5 | 5 | 3 |
| C6 CI 整合 (10) | 5 | 4 | 3 | 2 | 2 | 2 | 4 |
| C7 セキュリティ (10) | 5 | 5 | 4 | 4 | 4 | 4 | 2 |
| **合計** | **91** | **79** | **63** | **60** | **56** | **56** | *(失格)* |

> **C と E は 3 点差**しかないので、C6 / C7 の付け方で順位がひっくり返りうる。
> そこを恣意的にしないため、両方とも**下げ過ぎを直した**上での 3 点差である：
> C7 は「静的エクスポート＝ RLS 一枚」ではない（Edge Function なら認可を持てる）ので **3 → 4**、
> E の C6 は「既存 Playwright 基盤の失効」ではなく「ネイティブ用基盤の新設」なので **1 → 2**。
> **どちらの補正も C・E を持ち上げる向き**だが、それでも A・B との差は埋まらない。

### 4-3. 各案の読み解き

**A（91 点）— 現状維持＋インストール導線の強化.**
コストゼロで、**iOS / Android 双方で「アプリとして」起動する状態は既に手に入っている**のが効いている。
失点は C5 だけ：iOS では**自動インストールプロンプトが出せない**（手動で「ホーム画面に追加」を案内するしかない）、
Web Push は**ホーム画面インストール済み**が条件でブラウザタブでは届かない、バックグラウンド処理が乏しい。
逆に追い風もあり、**iOS 26 ではホーム画面に追加したサイトが既定で web app として開く**ようになった。
「アプリ化」の動機が *ホーム画面に置きたい / 通知が欲しい* であれば、**A で足りている可能性が高い**
（ただし通知の実装コストは §1 のとおり A でも発生する。**A が有利なのは実装が要らないからではなく、
実装先が web だけで済むから**）。

**B（79 点）— Android だけ Play へ.**
web 資産をそのまま使えて（C2 満点）、審査も TWA の要件を満たせば素直。
失点は C3：署名鍵の管理、Digital Asset Links、Play Console の年次ポリシー対応という
**「Vercel と Supabase 以外の運用対象」が 1 つ増える**。しかも C5 の見返りは小さい——
**TWA の中身は Chrome なので、通知は結局 Web Push のまま**で、Android では A と機能差がほとんど無い。
**「Android で得られるものが少ない」のが本質的な弱点**で、点数の高さの割に採る理由が薄い。

**C（63 点）— Capacitor ＋ 静的エクスポート（アプリ化する場合の本命）.**
Android / iOS を 1 つの web コードベースで賄える唯一の現実解で、C5 は満点。
ただし**代償が具体的かつ大きい**：
- **C2**: `output: 'export'` は **Server Action を実行できない**（サーバが無いので当然）。
  **30 本の Server Action を全てクライアントからの Supabase 直呼び / Edge Function に書き換える**必要がある。
  25 画面の Server Component 前提（`getUser()` 冒頭確認、`redirect` / `revalidatePath`）も総見直し。
  動的ルート（`/records/[id]` `/invite/[token]` `/share/[token]`）は静的エクスポートで別途手当が要る。
- **C7**: 移行先を **2 つに区別する必要がある**。
  **(a) クライアントから Supabase を直に呼ぶ**形にすると、アプリ層の認可ヘルパーが消えて **RLS 一枚に依存**する。
  この形を採るなら、**D16 で 2 度取り違えたあの認可判断（更新/削除は対象行の `household_id` で判定）を
  RLS 側だけで担保しきれているか**の検証が前提条件になり、D30 の Integration 層
  （「どの認可ヘルパーを呼んだか」を見るテスト）は検証対象ごと消える。
  **(b) Edge Function に移す**なら話は別で、**Server Action と同じ操作別の世帯・role チェックを関数側に持てる**
  （＝多層防御は維持できる）。ただし Deno ランタイム・デプロイ経路・シークレット管理という
  **運用対象が 1 つ増える**（C3 側の失点）。
  **既定は (b)**。「静的エクスポート＝ RLS 一枚」は必然ではなく、そう読める書き方は将来の移行を
  防御層の削減へ誘導するので採らない。C7 が 5 でなく 4 なのは、認証が Cookie セッションから
  ディープリンク＋トークン保管へ移り、**攻撃面が web だけの現状より広がる**ぶんの減点。
- **C3**: web / Android / iOS の 3 系統ビルド、2 ストア分の審査と鍵、そして OAuth リダイレクトを
  Cookie ベース（`@supabase/ssr`）から**カスタムスキームのディープリンクへ移す**作業。
- **C6**: Playwright の E2E / VRT は web ビルドに対しては生き続けるが、**端末上の挙動は別基盤**が要る。
  加えて、Server Action を剥がす改修そのものが**既存 E2E の前提（遷移・`redirect`）を動かす**ので、
  spec の書き換えが発生する。

**E（60 点）— Expo / React Native.**
ネイティブ体験は最良で、Supabase 公式の Expo クイックスタートも整備済み。EAS も無料枠（月 15 ビルド）で足りる。
それでも低いのは、**11.7k 行と 25 画面を UI ごと書き直し（C2）、web と RN の 2 UI を永続的に保守（C3）**
が同時に来るため。**React と TypeScript と Supabase クライアントの知識は再利用できる**
（そこが F・G との差）が、**コードは再利用できない**。
**C6 は「既存 Playwright 基盤が失効する」ではなく「ネイティブ用のテスト基盤を新設して二重に持つ」の減点**
—— web UI を残す前提なら既存の E2E / VRT は web を守り続けるので、失効するわけではない
（2 UI を保守するコスト自体は C3 で数えているため、C6 で二重に取らない）。

**F（56 点）— Flutter.** E の欠点をすべて持ち、さらに **Dart なので TypeScript の型資産（`src/types/database.ts`）も
Supabase の TS クライアントも捨てる**。E を上回る理由がこのプロジェクトには無い。

**G（56 点）— フルネイティブ.** 得られるものは最大だが、**web を含めて 3 コードベース**になる。
「少人数で使うアプリに運用対象を増やさない」という D18 の判断と正面から衝突する。

---

## 5. 結論

### 5-1. 採用：**A（PWA 継続＋インストール導線の強化）**。D18 は維持する

**現時点でストアアプリを作らない。** 理由は 3 つ。

1. **「アプリ化」で増える差分が小さい。** ホーム画面起動とオフライン表示は**もう動いている**。
   通知は未実装だが、**それはどの案でも新規に払うコスト**であってアプリ化の理由にはならない
   （A なら Web Push、C/E/F/G なら APNs / FCM。むしろ後者の方が重い）。
   最も点の高いストア案 B ですら、Android で増える機能はほぼ無い。
2. **ストア公開の主目的（発見・獲得）が家族向けアプリには無い。** 一方でコスト（審査の列、鍵、年次対応）は毎年かかる。
3. **本命の C は、いま払える額の工事ではない。** Server Action 30 本の撤去は機能追加ゼロの大改修で、
   しかも認可モデル（D16）の再検証を伴う。

### 5-2. いま実際にやること（A の中身）

- iOS / Android 向けの**「ホーム画面に追加」導線**を UI に用意する（iOS は手動導線しか無いため案内が必須）。
- `manifest` / アイコン / スプラッシュを実機で確認し、**スタンドアロン起動時の見た目**を VRT（D31）に足す。
- **Web Push は未実装**なので、入れるなら実装として起票する（`sw.js` の `push` ハンドラ、購読フロー、VAPID、送信側）。
  iOS は **16.4+ かつホーム画面インストール済み**が条件で、ブラウザタブには届かない。

### 5-3. 方針を覆す条件（これが起きたら C へ）

**A を採ったのは「今の要求では」であって、永久にではない。** 次のどれかが実際に起きたら C を再検討する。

- iOS で**通知が届かない / 取りこぼす**ことが実使用で問題になった。
- **他アプリの共有シートから mfmf へ送る**経路が欲しくなった（iOS に Web Share Target が無く、web では代替できない）。
  **写真の撮影・選択はこれに含まない** —— `RecordForm` の `<input type="file" accept="image/*">` で
  モバイルの Safari / Chrome はカメラを開けるので、「カメラを使いたい」だけでは移行の理由にならない。
- **iOS の PWA サポートが後退**した。前例がある —— Apple は DMA 対応として EU でのホーム画面 web app 廃止を
  一度告知し、**2024-03-01 に撤回**した（現在も EU 含め WebKit 上で動作する）。
  **この撤回があった以上「EU の利用者が出たら即アウト」は根拠にならない**が、
  同種の方針変更が再び起きうることは織り込む。

**そのときに採るのは C。** そして**その準備は今から前倒しできる**——
新しい Server Action を足すときに「**これは RLS だけで守れているか / クライアントから呼べる形か**」を
意識しておくだけで、C の移行コストは目に見えて下がる。

### 5-4. 「ストアに出す」より先に確認すべきこと

もし目的が **「家族の端末に、ちゃんとアプリとして入っている状態にしたい」** なら、
**production 公開は不要**である点を強調しておく：
**Play の internal testing（最大 100 名・12 人ルール対象外）** と
**TestFlight の internal tester（最大 100 名・審査なし）** で配れば、
**Apple 4.2 も Play の 12 テスター要件も回避できる**。
ただし **TestFlight ビルドは 90 日で失効**するので、
**四半期ごとに誰かが必ずビルドを上げ直す**という恒久運用を受け入れられるかが分岐点になる。

---

## 6. 参考にした情報

評価観点（§2）と事実関係（§4）の出典。

| 観点 / 事実 | 出典 |
| --- | --- |
| PWA / Capacitor / ネイティブの選び分け基準 | [Our Code World — PWA vs Capacitor vs Native (2026)](https://ourcodeworld.com/articles/read/3646/pwa-vs-capacitor-vs-native-2026) |
| Capacitor と React Native の比較軸 | [Capgo](https://capgo.app/blog/comparing-react-native-vs-capacitor/) / [NextNative](https://nextnative.dev/blog/capacitor-vs-react-native) |
| Apple ガイドライン 4.2（Minimum Functionality）と WebView ラッパーのリジェクト類型 | [MobiLoud](https://www.mobiloud.com/blog/app-store-review-guidelines-webview-wrapper) / [Code2Native](https://code2native.com/blog/fix-app-store-rejection-42-webview) |
| PWA をストアに出す手段と 2026 時点の限界（TWA / iOS 側の不成立） | [MobiLoud — Publishing a PWA to the stores](https://www.mobiloud.com/blog/publishing-pwa-app-store) |
| TWA / Bubblewrap の要件（Digital Asset Links・Lighthouse 80） | [GoogleChromeLabs/bubblewrap](https://github.com/googlechromelabs/bubblewrap) / [Thinktecture](https://www.thinktecture.com/en/pwa/twa-bubblewrap/) |
| 静的エクスポートで Server Action が動かないこと | [vercel/next.js Discussion #67503](https://github.com/vercel/next.js/discussions/67503) / [Capacitor での実例](https://medium.com/@shailendraparihar3630/i-built-a-mobile-app-the-wrong-way-so-you-dont-have-to-d7a46956d71a) |
| `server.url` が本番用ではないこと・プラグイン不整合 | [ionic-team/capacitor Discussion #5075](https://github.com/ionic-team/capacitor/discussions/5075) / [#4080](https://github.com/ionic-team/capacitor/discussions/4080) / [Capawesome](https://capawesome.io/blog/the-right-way-to-update-your-capacitor-app-remotely/) |
| iOS の PWA 制約（16.4+ の Web Push、インストール必須、iOS 26 の既定変更） | [MagicBell — PWA iOS Limitations (2026)](https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide) / [MobiLoud](https://www.mobiloud.com/blog/progressive-web-apps-ios) |
| **EU での PWA 廃止は撤回済み**（2024-03-01。上記 2 記事の「EU では不可」は誤り） | [9to5Mac](https://9to5mac.com/2024/03/01/apple-home-screen-web-apps-ios-17-eu/) / [TechCrunch](https://techcrunch.com/2024/03/01/apple-reverses-decision-about-blocking-web-apps-on-iphones-in-the-eu/) |
| 通知が未実装であること | 本リポジトリの `public/sw.js`（`install` / `activate` / `fetch` のみ）を実地確認 |
| Play の新規個人アカウント 12 テスター × 14 日ルール | [Play Console ヘルプ](https://support.google.com/googleplay/android-developer/answer/14151465?hl=en) |
| TestFlight の内部/外部テスター数・審査・90 日失効 | [TechConcepts — TestFlight Distribution Guide](https://techconcepts.org/blog/testflight-guide) / [Foresight Mobile](https://foresightmobile.com/blog/ios-app-distribution-guide-2026) |
| Expo / EAS の無料枠と Supabase 連携 | [Supabase Docs — Expo React Native](https://supabase.com/docs/guides/getting-started/tutorials/with-expo-react-native) / [EAS Build & Submit ガイド](https://www.generateideas.app/blog/expo-eas-build-submit-guide) |

---

- 決定ログの 1 行要約: [decisions.md](./decisions.md) の **D34**
- 判断基準（Mission / Vision / Values）: [principles.md](./principles.md)
- 元の却下判断: [decisions.md](./decisions.md) の **D18**
