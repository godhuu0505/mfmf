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
| DB | migration 32 本、RLS ＋ pgTAP でテナント分離を担保 | **DB スキーマと RLS は案によらず共有できる**（テーブル設計をやり直す案は無い）。ただし**「バックエンドが一切変わらない」わけではない** —— C の Edge Function 経路なら Deno 関数・デプロイ経路・シークレット管理が増え、通知を入れれば送信側が要り、ネイティブ系は OAuth / セッションの経路が変わる |
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
| **C1** | **ストア審査を通過できるか** | 15 | Apple ガイドライン **4.2（Minimum Functionality）**／**Play のポリシー審査**（TWA の Digital Asset Links・Lighthouse はこれとは別の技術要件）／Play の**新規個人アカウント 12 テスター × 14 日**ルール | 通らない案は他がどれだけ良くても成立しない（重みが大きい理由）。**ただし足切りには使わない** —— 「落ちる可能性が高い」と「出荷できない」は別で、前者は減点で表す。**ストアに出さない案には適用されない** —— その場合は N/A として除外し、残りの重みで正規化する（下記の注を参照） |
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
| **D** | **Capacitor ＋ `server.url`**（WebView が本番 URL を読むだけの薄いラッパー。**書き換えゼロで出せる唯一の案**） | Android ＋ iOS |
| **E** | **Expo / React Native で書き直し**（Supabase バックエンドは共有、UI は RN） | Android ＋ iOS |
| **F** | **Flutter で書き直し** | Android ＋ iOS |
| **G** | **Swift / Kotlin でフルネイティブ**（2 コードベース） | Android ＋ iOS |

---

## 4. 評価

### 4-1. C1（ストア審査）の見立て

**D は失格にしない（当初は足切りにしていたが撤回した）。** Capacitor の `server.url` は
Ionic 自身が「**開発用（live-reload）であって本番用ではない**」としており、
(1) Apple 4.2 から見て「URL を読むだけの汎用コンテナ」＝ *lazy wrapper* に見えやすい、
(2) web バンドルを更新するとネイティブ側の**プラグイン版とズレて壊れる**、という既知の問題がある。
ただし **Ionic の警告は運用上の推奨であって Apple の規則ではなく、実際に出荷している例もある**。
C についてすぐ下で「4.2 は個別判断でリスクと緩和策の問題」と書いている以上、
**同じ 4.2 を D にだけ「確実に落ちる」として適用するのは一貫性がない。**
しかも **D は 30 本の Server Action を書き換えずに済む唯一の案**なので、
足切りで消すと**それだけで結論が決まってしまう**。よって**採点して比較する**（結果は §4-2）。

**B と C はいずれも「通る見込みだが保証はない」。**

B について、**Digital Asset Links と Lighthouse は Play の審査基準ではない**。前者は Android パッケージと
サイトの関係を検証する仕組み、後者は Chrome / TWA 側の品質・フォールバック判定の基準で、
**満たしても Play の審査を通ることは保証されず、Play の各種ポリシー（データセーフティ・対象年齢・
権限など）は別途かかる**。ただし B の C1 を大きく下げているのはこれではなく、次の Google 側の要件。

C について、**Apple 4.2 は「プッシュ・カメラ・ネイティブナビを実装せよ」という条項ではない**。
見るのは「repackaged website を超える有用性があるか」で、**判断は個別ケース**。
mfmf は認証付きで自分たちの記録と写真を扱うアプリなので、単なるサイトの再梱包とは言いにくく、
**通る見込みはある**。ただし WebView 主体である以上**リジェクトのリスクは残り**、
その緩和策として最も効くのがネイティブ機能の追加、という関係にある。
**「4.2 のためにネイティブ実装が必須」ではなく「リスクと緩和策」**として扱う
（C の C2 / C5 はこの前提で採点している —— ネイティブ機能は 4.2 対策の義務としてではなく、
アプリ化で実際に得られる価値として C5 に計上した）。

**B の落とし穴は Apple ではなく Google 側にある。** 2023-11-13 以降に作られた**個人**開発者アカウントは、
production 公開の前に**クローズドテストで 12 人以上を 14 日間連続でオプトイン**させる必要がある
（法人＝ D-U-N-S 登録済みアカウントは免除）。**家族数人のアプリで 12 人は集まらない。**

**これは B の C1 に直接効く。** §3 で定義した B は「**Play に production 公開する**」案なので、
**その前提条件が事実上満たせない**ことになる。**B の C1 は 2**（0 でも 1 でもないのは、
D-U-N-S の法人アカウントなら免除され、12 人を集めること自体が原理的に不可能でもないため）。
**ただしこれは「アカウントが 2023-11-13 以降の個人アカウントである」という未検証の仮定に依存する**
（§4-2 の注 ※2）。

なお **「production を諦めて internal testing で配る」のは B とは別の deliverable** であり、
ここで B の点数に混ぜない（混ぜると「審査を通過できるか」を問うている C1 で、
審査を受けない配り方に点を付けることになる）。その道は **§5-4** に分けて書く。

### 4-2. スコア（5 点満点 × 重み、100 点換算）

| 観点（重み） | **A** PWA 継続 | **B** TWA(Android) | **C** Capacitor+静的 | **E** Expo/RN | **F** Flutter | **G** ネイティブ | **D** Capacitor+`server.url` |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| C1 審査 (15) | **—** | 2※2 | 4 | 5 | 5 | 5 | **2** |
| C2 再利用 (20) | 5 | 5 | 2 | 2 | 1 | 1 | **5** |
| C3 運用手間 (20) | 5 | 3 | 2 | 1 | 1 | 1 | **2** |
| C4 金銭 (10) | 5 | 4 | 3 | 3 | 3 | 3 | 3 |
| C5 ネイティブ機能 (15) | 2 | 2 | 5 | 5 | 5 | 5 | **2** |
| C6 CI 整合 (10) | 5 | 4 | 3 | 2 | 2 | 2 | 4 |
| C7 セキュリティ (10) | 5 | 5 | 4 | 4 | 4 | 4 | **2** |
| **合計** | **89**※1 | **70**※2 | **63** | **60** | **56** | **56** | **58** |

> ※1 **A は C1 が N/A**（ストアに出さないので「審査を通過できるか」を問えない）。
> **適用される 6 観点（重み計 85）で正規化して 89**。
> **N/A を 0 点にはしない** —— 0 は「審査に落ちる」を意味し、**審査が存在しない A の実態と正反対**になる。
> （参考: 仮に 0 としても A は 76 で、**B（70）を上回る**。どちらの扱いでも順位は変わらない。）
> なお「審査の列に並ばない」ことの運用上の利得は **C3 で既に数えている**ので、
> C1 を N/A にすることで二重計上も避けられる。

> ※2 **B の C1 = 2 は「Play の開発者アカウントが 2023-11-13 以降に作られた個人アカウント」という
> 未検証の仮定に依存する。** この仮定はリポジトリからは確認できない（アカウント種別も作成日も
> どこにも記録が無い）。**免除される場合（法人＝ D-U-N-S 登録済み、または同日より前に作られた個人
> アカウント）は C1 = 4 となり B は 76。** どちらでも **A（89）は上回らない**ので結論は変わらないが、
> **B を実際に検討するなら最初に確認すべき事実**なので、仮定であることを明示しておく。

> **D を採点に戻した経緯**（当初は足切りにしていた）: C2 が満点なのは、**hosted な Next.js を
> そのまま使い続けるので Server Action 30 本が生き残る**ため —— これは他のどの案にも無い長所。
> 一方 **C3 = 2** は、2 ストア分の運用に加えて **web を更新するたびにネイティブ側のプラグイン版と
> ズレて壊れうる**という恒常的な破損源を抱えるため。**C5 = 2** は、Ionic 自身が
> **この構成ではプラグインが正常に機能しないとしている**ので「ネイティブ機能が得られる」と言えず、
> オフライン時はホワイトアウトするため。**C7 = 2** は、ネイティブシェルが**リモートの内容を読み込む**
> 形になり、プラグインと web のバージョン不整合も攻撃面・障害面を広げるため。
> **合計 58 で E（60）と F・G（56）の間**。「書き換えずに済む」という一点で買えるものは、
> この重み付けでは A・B・C を超えない。

> **C と E は 3 点差**しかないので、C6 / C7 の付け方で順位がひっくり返りうる。
> そこを恣意的にしないため、両方とも**下げ過ぎを直した**上での 3 点差である：
> C7 は「静的エクスポート＝ RLS 一枚」ではない（Edge Function なら認可を持てる）ので **3 → 4**、
> E の C6 は「既存 Playwright 基盤の失効」ではなく「ネイティブ用基盤の新設」なので **1 → 2**。
> **どちらの補正も C・E を持ち上げる向き**だが、それでも A・B との差は埋まらない。

### 4-3. 各案の読み解き

**A（89 点 / C1 は N/A）— 現状維持＋インストール導線の強化.**
**増分コストが最も小さく**、**iOS / Android 双方で「アプリとして」起動する状態は既に手に入っている**のが効いている。
**ゼロではない** —— §5-2 のインストール導線 UI と VRT は新規作業で、UI が付く以上
D24 の静的プロトタイプ・実機合意・D25 の E2E も要る。ただし**すべて web 側だけで完結する**。
失点は C5 だけ：iOS では**自動インストールプロンプトが出せない**（手動で「ホーム画面に追加」を案内するしかない）、
Web Push は**ホーム画面インストール済み**が条件でブラウザタブでは届かない、バックグラウンド処理が乏しい。
逆に追い風もあり、**iOS 26 ではホーム画面に追加したサイトが既定で web app として開く**ようになった。
「アプリ化」の動機が *ホーム画面に置きたい / 通知が欲しい* であれば、**A で足りている可能性が高い**
（ただし通知の実装コストは §1 のとおり A でも発生する。**A が有利なのは実装が要らないからではなく、
実装先が web だけで済むから**）。

**B（70 点）— Android だけ Play へ.**
web 資産をそのまま使えて（C2 満点）、TWA の技術要件（Digital Asset Links）は素直に満たせる。
失点は C3：署名鍵の管理、Digital Asset Links、Play Console の年次ポリシー対応という
**「Vercel と Supabase 以外の運用対象」が 1 つ増える**。しかも C5 の見返りは小さい——
**TWA の中身は Chrome なので、通知は結局 Web Push のまま**で、Android では A と機能差がほとんど無い。
そのため **C5 は A と同じ 2**（当初 3 としていたが、**Play に並ぶことと Digital Asset Links は
「ネイティブ機能」ではない**ので、加点の根拠が無かった）。
さらに **C1 も 2 に留まる** —— §4-1 のとおり、この案が目指す production 公開には
**12 テスター × 14 日**という、家族数人では満たせない前提条件がある。
**「Android で得られるものが少ないのに、運用対象は増え、しかも公開自体が詰まる」**というのが B の実像。

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
  防御層の削減へ誘導するので採らない。C7 が 5 でなく 4 なのは、**セッションが HttpOnly Cookie から
  端末側のトークン保管へ移り**、コールバック経路の検証も自前で設計することになる（＝攻撃面が
  web だけの現状より広がる）ぶんの減点。**リダイレクト方式そのものは選べる**ので、
  Universal Links / App Links を採れば減点は最小に留まる。
- **C3**: web / Android / iOS の 3 系統ビルド、2 ストア分の審査と鍵、そして OAuth コールバックを
  Cookie ベース（`@supabase/ssr`）から**モバイル向けの経路へ移す**作業。
  **カスタムスキームである必要はなく、検証済みの Universal Links / App Links を使える**
  （スキーム乗っ取りを避けられるのでそちらが望ましい）。
- **C6**: Playwright の E2E / VRT は web ビルドに対しては生き続けるが、**端末上の挙動は別基盤**が要る。
  加えて、Server Action を剥がす改修そのものが**既存 E2E の前提（遷移・`redirect`）を動かす**ので、
  spec の書き換えが発生する。

**E（60 点）— Expo / React Native.**
ネイティブ体験は最良で、Supabase 公式の Expo クイックスタートも整備済み。EAS も無料枠（月 15 ビルド）で足りる。
それでも低いのは、**11.7k 行と 25 画面を UI ごと書き直し（C2）、web と RN の 2 UI を永続的に保守（C3）**
が同時に来るため。**React と TypeScript と Supabase クライアントの知識は再利用でき**（そこが F・G との差）、
**フレームワーク非依存の TypeScript はそのまま持ち込める**（`@supabase/supabase-js` は React Native で動く）——
`src/types/database.ts`（274 行）＋ `dateRange` `storagePath` `recordQuery` `guest` で **515 行**
（import を推移的に辿り、さらにランタイム API の使用も確認した実測値）。
**再利用できないのは UI とサーバ結合部**: 25 画面の DOM、Server Action、
`imageResize.ts`（`createImageBitmap` / `canvas.toBlob` を使うブラウザ専用）、
そして次の 2 群も**そのままは動かない**：
- **`photos` `tags` `pets` `profile` `avatars` `userAvatar`** は `@/lib/supabase/server`
  （＝ `next/headers` と HttpOnly Cookie セッション）に依存 —— クライアント注入の形に直せば移せる
- **`google/crypto`（`node:crypto`）・`google/token`（`GOOGLE_CLIENT_SECRET`）・`signup`（`SIGNUP_ENABLED`）**
  は**サーバーに残すべきもの**、**`quickDraft`（`sessionStorage`）・`householdSync`（`BroadcastChannel`）**
  は**ブラウザ API 依存**でプラットフォーム別アダプタが要る

**515 行は 11.7k 行の約 4%** なので、**C2 は 2 のまま**とした。
**C6 は「既存 Playwright 基盤が失効する」ではなく「ネイティブ用のテスト基盤を新設して二重に持つ」の減点**
—— web UI を残す前提なら既存の E2E / VRT は web を守り続けるので、失効するわけではない
（2 UI を保守するコスト自体は C3 で数えているため、C6 で二重に取らない）。

**F（56 点）— Flutter.** E の欠点をすべて持ち、さらに **Dart なので TypeScript の型資産（`src/types/database.ts`）も
Supabase の TS クライアントも捨てる**。E を上回る理由がこのプロジェクトには無い。

**G（56 点）— フルネイティブ.** 得られるものは最大だが、**web を含めて 3 コードベース**になる。
「少人数で使うアプリに運用対象を増やさない」という D18 の判断と正面から衝突する。

**D（58 点）— Capacitor ＋ `server.url`.**
**唯一「書き換えゼロ」で Android / iOS に出せる案**（hosted な Next.js をそのまま読むので
Server Action 30 本が生き残る）。それでも中位に留まるのは、その一点以外がすべて悪いから ——
Ionic 自身が本番用途を否定しており、**この構成ではプラグインが正常に動かない**ので
「アプリ化して何が増えるのか」に答えられず（C5 = 2）、
**web を更新するたびにネイティブ側とバージョンがズレて壊れうる**（C3 = 2）、
オフラインでホワイトアウトし、Apple 4.2 の *lazy wrapper* 類型にも当たりやすい（C1 = 2）。
**「移行コストを払わずにアプリ化したい」という最も魅力的な動機に応える案が、
実際には最も脆い**というのがこの選定で一番わかりにくい結論なので、失格ではなく点数で示した。

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
  **ゼロからではない** —— `src/app/(app)/help/page.tsx` に文章での案内が既にある。
  足りないのは**気づける場所への導線**と、Android の `beforeinstallprompt`（リポジトリ全体に実装なし）。
- `manifest` / アイコン / スプラッシュは**実機で確認する**。**ここは VRT では代替できない** ——
  Playwright は通常の Chromium ページを開くだけで、**PWA のインストールも、OS が描くスプラッシュも、
  ホーム画面アイコンも検証できない**（緑のまま起動体験が壊れうる = V4）。
  **VRT に足すのは「起動後の DOM」だけ**（`display-mode: standalone` 相当の描画）と割り切り、
  インストールと起動そのものは実機チェックの項目として残す。
- **Web Push は未実装**なので、入れるなら実装として起票する（`sw.js` の `push` ハンドラ、購読フロー、VAPID、送信側）。
  iOS は **16.4+ かつホーム画面インストール済み**が条件で、ブラウザタブには届かない。

### 5-3. 方針を覆す条件（これが起きたら C へ）

**A を採ったのは「今の要求では」であって、永久にではない。** 次のどれかが実際に起きたら C を再検討する。

- iOS で**通知が届かない / 取りこぼす**ことが実使用で問題になり、かつ**原因が iOS の Web Push 側の
  制約だと切り分けられた**。**「届かなかった」だけでは足りない** —— 許可の取り消し・購読の期限切れ・
  送信側や VAPID の不具合・端末オフラインが原因なら、ネイティブへ移っても直らない
  （APNs / FCM も配信を保証しない）。
- **他アプリの共有シートから mfmf へ送る**経路が欲しくなった（iOS に Web Share Target が無く、web では代替できない）。
  **写真の撮影・選択はこれに含まない** —— `RecordForm` の `<input type="file" accept="image/*">` で
  モバイルの Safari / Chrome はカメラを開けるので、「カメラを使いたい」だけでは移行の理由にならない。
- **iOS の PWA サポートが後退**した。前例がある —— Apple は DMA 対応として EU でのホーム画面 web app 廃止を
  一度告知し、**2024-03-01 に撤回**した（現在も EU 含め WebKit 上で動作する）。
  **この撤回があった以上「EU の利用者が出たら即アウト」は根拠にならない**が、
  同種の方針変更が再び起きうることは織り込む。

**そのときに採るのは C。** そして**その準備は今から前倒しできる**——
新しい Server Action を足すときに「**そのまま Edge Function へ移せる形か**」を意識しておくだけで、
C の移行コストは目に見えて下がる。**アプリ層の認可を省くという意味ではない**（§4-3 の C7 のとおり、
`getUser()` と操作別の世帯 / role チェックは移行先でも持っていく）。

### 5-4. 「ストアに出す」より先に確認すべきこと

もし目的が **「家族の端末に、ちゃんとアプリとして入っている状態にしたい」** なら、
**production 公開は不要**である。ただし **Android と iOS で難易度がまったく違う**。

**Android は素直。** Play の **internal testing**（最大 100 名、メールアドレスで招待）は
**12 テスター × 14 日ルールの対象外**で、production 審査も通らずに配れる。

**iOS は条件付き。** よく「TestFlight の internal tester なら審査なし」と言われるが、
**internal tester は任意の Apple ID ではなく、App Store Connect のユーザーとして
役割（Admin / App Manager / Developer / Marketing 等）を与えた相手に限られる**。
つまり**家族全員に開発者コンソールのアカウントを配ることになる**。選択肢は 3 つ：

| 配り方 | 上限 | 審査 | 引き換えに払うもの |
| --- | --- | --- | --- |
| **TestFlight internal** | 100 | **なし**（アップロード後すぐ） | 家族を **App Store Connect ユーザーとして招待**する必要がある（権限管理が増える） |
| **TestFlight external** | 10,000 | **あり**（各バージョンの初回ビルドに Beta App Review、通常 24 時間程度）。**同一バージョンの以降のビルドは審査を省略できることが多いが、保証はない** —— Apple は後続ビルドも審査対象に選べる | 審査の列に並ぶ。**バグ修正を急いで配りたいときに待たされうる**。ただしコンソールのアカウントは不要 |
| **Ad Hoc** | 端末 **100 台/年** | なし | 端末 **UDID の登録**とプロビジョニングプロファイル管理。**証明書 / プロファイルが切れるとインストール済みのアプリが起動しなくなる**ので、**年 1 回、署名し直したビルドを全端末に配り直して入れ直す**必要がある（コンソール作業だけでは終わらない） |

**どれを選んでも `$99/年` は付いてくる。** さらに **TestFlight は 90 日でビルドが失効**し、
**Ad Hoc は年 1 回の再配布・再インストール**が要る —— どちらも「置いたら終わり」にはならない。
「審査を完全に回避できる」と言えるのは **internal（＋コンソールアカウント配布）か Ad Hoc（＋ UDID 管理）**
に限られ、**いずれも C1 で浮いたぶんを C3 の恒久運用で払い直す**構造になっている。
これが「家族に配るだけならストア不要」という話の実際のコストで、
**その周期の運用を受け入れられるか**が分岐点になる —— **TestFlight なら 90 日を切らないうちの再アップロード**
（「四半期ごと」では足りない —— 暦の四半期は 91〜92 日あり、失効期間に穴が開く。目安は 2〜3 か月）。開発者側で完結する、**Ad Hoc なら年 1 回の再署名と全端末の入れ直し**（家族の端末を回る作業）。
頻度は Ad Hoc の方が低いが、**手間の質はこちらの方が重い**。

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
