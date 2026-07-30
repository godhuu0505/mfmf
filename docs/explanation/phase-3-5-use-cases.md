# Phase 3.5 ユースケース・バックログ（家族・権限・サインアップ・共有）

Phase 3.5（エピック [#91](https://github.com/godhuu0505/mfmf/issues/91)）を「家族グループ・認証認可・
初回サインアップ・外部アカウント・共有」の観点で**ユースケース単位に洗い出した**バックログです。
[vision-and-roadmap.md](./vision-and-roadmap.md) が **何を作るか（機能カタログ）** を俯瞰するのに対し、
本書は **誰が・何のために・どう振る舞うべきか（受け入れ条件付き）** を残し、GitHub Issue（S1〜S5）へ
落とすときの元ネタにします。

- 現状の「何が」あるかは [reference/architecture.md](../reference/architecture.md)
- 設計の「なぜ」は [decisions.md](./decisions.md)
- フェーズ俯瞰・機能カタログは [vision-and-roadmap.md](./vision-and-roadmap.md)
- DB / RLS の正は [`supabase/migrations/`](../../supabase/migrations/)

状態凡例：✅実装済 / 🟢採用（未実装・ロードマップ確定）/ 🟡検討中 / 💡将来 / ⛔スコープ外

> ⚠️ 本書のユースケースの多くは **未実装**。実装状況は各表の「状態」列と §1 の現況を参照。

---

## 1. 現況スナップショット（2026-07 時点・main）

S1（[#92](https://github.com/godhuu0505/mfmf/issues/92)）の無停止移行8手順の進捗:

| 手順 | 内容 | 状態 | 実体 |
| --- | --- | --- | --- |
| 1 | `households` / `household_members` テーブル + RLS | ✅ | `20260630130000_households.sql`（PR #96） |
| 2 | 業務表に `household_id` を nullable 追加 | ✅ | `20260630130100_household_id_backfill.sql` |
| 3 | 既存ユーザーを既定 household に owner でバックフィル | ✅ | 同上 |
| 4 | メンバーシップ RLS を `owner_id` と**併存**追加 | ✅ | `20260630140000/140100`（PR #98）。`has_household_role` / `is_household_member` |
| 5 | pgTAP でテナント分離を証明 | ✅ | `supabase/tests/household_rls_test.sql`（28 assert）+ CI |
| 6 | `household_id` を **NOT NULL** 化 | ✅ | `20260703160000_household_id_not_null.sql`（PR #102/#105）。型も `string` へ更新済み |
| 7 | アプリ読み書きを household 基準へ切替 | ✅ | `src/lib/household.ts`（PR #99） |
| 8 | **Storage パスの household 化** | ✅ | `20260703120000_storage_household_paths.sql`。新規アップロードは `{household_id}/...`、既存 `{owner_id}/...` は移動せず世帯メンバー読取ポリシーを併存 |

- **S2 RBAC（[#46](https://github.com/godhuu0505/mfmf/issues/46)）**: **DB/RLS は完了**。role は CHECK 制約（owner/editor/viewer, `20260703170000`）、write は editor 以上に限定、旧 owner_id write ポリシーは切替済み（drop, `20260704000000`。feedback 送信・タグ昇格用 update 等の意図した例外は migration ヘッダー参照）。ロール変更（UC-H04）/世帯名変更（UC-H02）の RLS と D6（最後の owner 保護）トリガも導入済み。メンバー削除/退出（UC-H05/H06）は UC-H10 の読取述語緩和と一体で S3 #45 にて解禁。アプリ層も完了: Server Action のロール検査（`requireEditableHousehold`）、viewer への UI 出し分け（一覧/詳細/新規/ペット, UC-A06）、/settings の世帯セクション（世帯名変更 UC-H02・メンバー一覧 UC-H03・ロール変更 UC-H04）。**S2 はこれで完了**（招待・削除・退出の UI は S3）。
- **S3 内部招待（[#45](https://github.com/godhuu0505/mfmf/issues/45)）**: **完了**。招待（`household_invites` + 宛先メール固定の受諾 D12/D13、UC-O09〜O11）、退出/削除（UC-H05/H06 + D6、UC-H10 読取緩和）、世帯切替（Cookie ベースの現在世帯 UC-H08・複数世帯参加 UC-H07 の解禁 = D2 解除）、メンバー表示のメール/名前解決（`get_household_members`）。
- **S4 外部ゲスト（[#93](https://github.com/godhuu0505/mfmf/issues/93)）**: **完了**。`guest_grants`（対象ペット・期間限定、`20260705000000`）+ ゲスト RLS ヘルパー + 記録の明示共有フラグ `daycare_records.guest_visible`（D8 既定 deny）。ゲスト招待は S3 招待基盤を流用（`20260705010000`: `household_invites` に guest role + `scope_pet_id` + 期間、受諾で `guest_grants` を作成・メンバー化しない）。/settings にゲスト招待・付与管理（owner）、記録詳細に「ゲストに共有」トグル、`/guest`・`/guest/records/new` にゲスト向け閲覧/記入 UI。**`share_links` 廃止**（D4/UC-S01, `20260705020000`）: `get_shared_view` を常時無効化・既存リンク一括失効、`/shares` は終了案内・ナビから撤去（テーブル・`get_shared_view` の物理 DROP は #117 で完了: `20260705030000`）。pgTAP: guest_grants 28 + guest_invites 10 assert。
- **Phase 3.5（[#91](https://github.com/godhuu0505/mfmf/issues/91)）全体**: **S1〜S5 完了**。世帯テナント分離（S1）・RBAC（S2）・内部招待/退出/切替（S3）・外部ゲスト（S4）・公開サインアップ基盤（S5、flag で閉塞中）。残る論点は §7（世帯削除 UC-H09・写真つきゲスト共有 UC-S04・アイデンティティ連携・監査ログ）で、いずれも Phase 4/5 送り。
- **S5 公開サインアップ（[#47](https://github.com/godhuu0505/mfmf/issues/47)）**: **実装完了（S4 より先行。D3/D7 の認証基盤を先に整えた）**。世帯プロビジョニング（UC-O03: `create_own_household` SECURITY DEFINER = 未所属ユーザーのみ新世帯作成 + owner 化、`/onboarding` → 最初のペット登録導線 UC-O05）、email/password 認証（UC-O02: `/signup` メール確認つき登録・`/login` ログイン・`/forgot-password`→`/reset-password` 再設定）、同意チェック（UC-O06 暫定）、feature flag（UC-O08: `SIGNUP_ENABLED` 既定閉）。**公開（flag 開放）は課金 #49・法務 #50・濫用対策 #37 と揃えてから**。Google ログインは従来どおり（`drive.file` スコープ要求）。
- **既存の共有**: Phase 2 の `share_links`（匿名 read-only トークン）は **S4 で廃止**（D4/UC-S01, `20260705020000`）。`get_shared_view` は常時無効・既存リンクは一括失効済み。閲覧共有は viewer 招待（S3）or 期間限定ゲスト招待（S4）へ一本化。テーブル・`get_shared_view` の物理 DROP は #117 で完了（`20260705030000`）。

---

## 2. アクター（ペルソナ）

| アクター | 説明 | 認証 | 代表ロール |
| --- | --- | --- | --- |
| **飼い主（夫婦）** | 世帯の主。全権 | Google（現状） | owner |
| **同居家族・主たる世話人** | 記録・写真・予定を日々編集 | Google / email | editor |
| **祖父母など** | 見るだけ | Google / email | viewer |
| **保育園** | 預かり中の担当ペットを記録・閲覧 | email/password（Google 非依存を許容, D3） | guest:daycare |
| **ペット/ベビーシッター** | 預かり期間だけ・対象ペットだけ | 同上 | guest:sitter |
| **新規セルフ登録者** | 公開後に自力で登録（Phase 5 課金と並走） | Google / email | 登録後 owner |

---

## 3. 設計決定ログ（本バックログの前提）

このバックログを支える確定判断。以後のユースケースはこれに従う。

| # | 決定 | 帰結 / 影響 |
| --- | --- | --- |
| **D1** | ユーザー×複数世帯は**採用**（データモデル）。1匹×複数世帯（`pet_households`）は**⛔スコープ外**（YAGNI） | `household_members` の多対多は活かす。`pets.household_id` は単一のまま |
| **D2** | 世帯切替UIは**S3 招待と同時**に導入。それまでは実質シングル世帯として運用 | 切替UIが無い状態で多世帯招待を許すと「見えないデータ」が生じる矛盾を回避 |
| **D3** | 外部アカウントは Google 非依存を許容 → **email/password（or magic link）を追加** | S5 に認証方式追加。保育園が Google を持たなくても参加可能 |
| **D4** | 匿名リンク閲覧は**廃止**し全員アカウント必須。`share_links` は**廃止**し `guest_grants` へ一本化 | ゼロ摩擦の匿名閲覧を捨てる代わり「誰が見たか」を追跡可能に。既存発行済みリンクの移行/失効が必要 |
| **D5** | **editor は他人が書いた記録も編集可**（世帯データ＝共有物） | RLS は `owner_id` 一致ではなく「世帯メンバー かつ role」で判定 |
| **D6** | **owner は複数可**・最後の 1 人は降格/退出**不可**（世帯の孤児化防止） | サーバー側で「世帯の owner 数 ≥ 1」を強制 |
| **D7** | セルフサインアップは**新世帯作成で owner 化**と**招待受諾で既存世帯参加**の**両導線** | S5 と S3 が直結。登録直後に world が 0 個にならない |
| **D8** | 外部ゲストの可視範囲は最厳格：**ペットプロフィール＋期間内に共有された記録のみ** | S4 の既定は deny。owner が明示共有した記録＋ゲスト自身の記入だけが見える |
| **D9** | 3.5 に**含める**：手順8 Storage の household 化 / `tags`・`record_tags` の household 共有。**後回し**：手順6 NOT NULL 化。**個人のまま維持**：`profiles` / `google_credentials` | 移行残債の線引き |
| **D10** | 共有世帯での Google Drive 原本の所有者は **3.5 では決めない**（Drive 連携自体が 3.5 後） | §7 未決事項へ |
| **D11** | **記録の削除は editor 全員が可**（他人の記録も。編集 D5 と同等） | RLS の delete も「世帯メンバー かつ role∈{owner,editor}」で判定 |
| **D12** | 招待の宛先は**メールアドレス固定**（指定アドレスのアカウントだけ受諾可） | オープンリンクは採らない。受諾時にメール一致を要求 |
| **D13** | 既登録者を招待したら、**ログイン中アカウントのメールが宛先と一致すればワンクリック参加**（不一致は拒否） | D12 と整合。別アカウントでの誤受諾を防ぐ |
| **D14** | アカウント退会は**最小＝自分の membership 退出のみ**（owner 保護 D6）。完全削除・エクスポートは Phase 5 法務（#50）へ | 「忘れられる権利」全部は 3.5 に載せない |

---

## 4. ユースケース一覧

ID 体系: `UC-<領域><連番>`。領域 = H(家族グループ) / A(認証認可) / O(オンボ・サインアップ) /
G(外部ゲスト) / S(共有) / M(移行・非機能)。

### A. 家族グループ（household ライフサイクル） — S1〜S3

| ID | ユースケース | アクター | スライス/Issue | 状態 | 受け入れ条件 |
| --- | --- | --- | --- | --- | --- |
| UC-H01 | 既存ユーザーが自動で既定世帯（owner）に所属している | 飼い主 | S1 / #43 | ✅ | バックフィル後、全既存行に `household_id`。表示は不変・ダウンタイム無し |
| UC-H02 | 世帯に名前を付ける / 変更する | owner | S1〜S2 | 🟢 | `households.name` を設定・編集。空でも動作（既定は空文字） |
| UC-H03 | メンバー一覧を見る（誰が owner/editor/viewer か） | 世帯メンバー | S2/S3 / #45,#46 | 🟢 | 自世帯のメンバーと role を一覧。他世帯は不可視 |
| UC-H04 | メンバーの role を変更する | owner | S2 / #46 | 🟢 | owner のみ実行可。**最後の owner を降格不可**（D6）。サーバー強制 |
| UC-H05 | メンバーを削除する | owner | S3 / #45 | 🟢 | owner のみ。**最後の owner は削除不可**（D6）。削除後、その人は自世帯データを閲覧不可 |
| UC-H06 | 自分から世帯を退出する | 全メンバー | S3 / #45 | 🟢 | **最後の owner は退出不可**（D6）。退出後は当該世帯を不可視 |
| UC-H07 | 1 ユーザーが複数世帯に所属する | editor/viewer | S3（+切替UI, D2） | 🟢 | データモデルは許容。UI 切替は UC-H08 とセットで解禁 |
| UC-H08 | 「現在の世帯」を切り替える | 複数所属者 | S3 / #45（D2） | 🟢 | 切替を Cookie/セッションに保持。全画面が現在世帯に追従。切替UI 未導入の間は招待受諾を 1 世帯に制限（D2） |
| UC-H09 | 世帯を削除する | owner | #117 §3 | 🟢 一部 | **参照データの無い世帯**は owner が削除可（`delete_own_household` + D6 ガード, `20260705040000`）。データのある世帯の完全削除は #51（Phase 5）→ §7 |
| UC-H10 | 退出/削除されたメンバーが作った記録は世帯に残る | 世帯 | S2/S3 | 🟢 | `owner_id` は残置（記録は消えない）。閲覧は世帯メンバーシップ RLS で世帯側に残る。作成者本人は退出後アクセス不可 |
| UC-H11 | ペット削除時に紐づく記録・写真・ゲスト付与を畳む | owner | S4 / #44,#93 | ✅ | 決定（2026-07-04）: 記録は残す（`records.pet_id` は SET NULL 維持）、`guest_grants.scope_pet_id` は CASCADE。pgTAP 済 |

### B. 認証・認可（RBAC） — S2

| ID | ユースケース | アクター | スライス/Issue | 状態 | 受け入れ条件 |
| --- | --- | --- | --- | --- | --- |
| UC-A01 | viewer は閲覧のみ（作成/編集/削除 UI が出ない・サーバーでも拒否） | viewer | S2 / #46 | 🟢 | クライアント回避不可。RLS/Server Action の両方で write 拒否 |
| UC-A02 | editor は記録/写真/予定/ペット情報を追加・編集できる | editor | S2 / #46 | 🟢 | **他人が書いた記録も編集可**（D5）。`owner_id` 一致は要求しない |
| UC-A03 | 記録・写真の削除は editor 全員が可（他人の記録も） | editor/owner | S2 / #46（D11） | 🟢 | RLS の delete も「世帯メンバー かつ role∈{owner,editor}」で判定。viewer は不可 |
| UC-A04 | owner はメンバー管理・招待・削除ができる | owner | S2/S3 | 🟢 | owner のみ。自己昇格不可（UC-A05） |
| UC-A05 | 自己昇格を防ぐ（非 owner が自分を owner にできない） | 攻撃者 | S2/S3 / #38 | 🟢 | `household_members` への自己 INSERT/UPDATE は deny by default（pgTAP 済 #98） |
| UC-A06 | role 別に UI を出し分ける（viewer に編集ボタンを見せない） | 全メンバー | S2 / #46 | 🟢 | サーバー強制が一次防衛線。UI は補助 |
| UC-A07 | 全 Server Action で `getUser()` 認可を維持する | 全操作 | 横断 | ✅→維持 | 既存不変条件。role チェックを足しても `getUser()` は省略しない |

### C. 初回サインアップ / オンボーディング — S5

| ID | ユースケース | アクター | スライス/Issue | 状態 | 受け入れ条件 |
| --- | --- | --- | --- | --- | --- |
| UC-O01 | Google でサインアップ/ログインする | 全員 | 既存 / S5 | ✅ | 実装済（`drive.file` スコープ、offline+consent でリフレッシュトークン取得） |
| UC-O02 | email/password（or magic link）で登録/ログインする | 外部/一般 | S5 / #47（D3） | ✅ | `/signup`（メール確認つき登録）・`/login`（email/password ログイン）・`/forgot-password`→`/reset-password`（再設定）。登録 UI は flag 閉塞中は非表示（UC-O08） |
| UC-O03 | 新規登録者が新世帯を作成し owner になる | 新規 | S5 / #47（D7） | ✅ | `create_own_household`（SECURITY DEFINER・未所属のみ）+ `/onboarding`。登録＝auth ユーザー作成→**新 household 作成→owner 化**→オンボ。world が 0 個にならない |
| UC-O04 | 招待リンク経由で登録し、既存世帯に参加する | 被招待者 | S3+S5 / #45,#47（D7） | ✅ | 招待受諾でのみ member 化（S3）。アカウントは Google（常時）/ email/password（flag 開放時）で作成可。role は招待時指定。**自己昇格不可** |
| UC-O05 | 初回オンボ（ペット登録・サンプル記録） | 新規 owner | S5 / #47 | ✅ | `/onboarding`（世帯作成）→ `/pets`（最初のペット登録）へ導線。サンプル記録は見送り |
| UC-O06 | 利用規約・プライバシーへ同意する | 新規 | S5 / #47・#50 | ✅（暫定） | `/signup` で同意チェック必須・同意時刻を user_metadata（`tos_accepted_at`）へ記録。正式な文書と監査可能な同意台帳は #50 で整備 |
| UC-O07 | 不正登録・bot を抑止する | 攻撃者 | S5 / #37 | 🟡 | Supabase 側のサインアップ/メール送信レート制限 + flag 閉塞（UC-O08）で当面カバー。CAPTCHA 等は #37 |
| UC-O08 | 公開前は feature flag でサインアップを閉じておく | 運用 | S5 / #47 | ✅ | 環境変数 `SIGNUP_ENABLED`（既定: 閉）で `/signup` と導線を閉塞。API 自体の閉塞は Supabase 側 signup 許可も無効にする（`src/lib/signup.ts` 参照） |
| UC-O09 | メールアドレス固定で招待する（指定アドレスだけ受諾可） | owner | S3 / #45（D12） | ✅ | オープンリンクは採らない。受諾時に**宛先メール一致を要求**。期限・失効・取消・再送を owner が管理 |
| UC-O10 | 既登録者はログイン中アカウントのメール一致でワンクリック参加 | 被招待者 | S3 / #45（D13） | ✅ | ログイン中アカウントのメールが宛先と一致→即参加。**不一致は拒否**（別アカウントでの誤受諾防止） |
| UC-O11 | 招待は期限切れ/失効/取消で無効化される | owner | S3 / #45 | ✅ | 受諾でのみメンバー化（自己昇格不可 UC-A05）。owner のみ招待・取消 |
| UC-O12 | アカウント退会は自分の membership 退出のみ（3.5 最小） | 本人 | S3 / #45（D14） | 🟢 | 各世帯から退出（**最後の owner は不可** D6）。完全なアカウント削除・データエクスポートは Phase 5 法務（#50）へ |

### D. 外部アカウント・ゲスト — S4

| ID | ユースケース | アクター | スライス/Issue | 状態 | 受け入れ条件 |
| --- | --- | --- | --- | --- | --- |
| UC-G01 | 保育園/シッターを対象ペット・期間限定で招く | owner | S4 / #93 | ✅ | `guest_grants` + RLS。招待は S3 基盤を流用（`household_invites` に guest role + `scope_pet_id` + 期間）。/settings で発行・失効 |
| UC-G02 | ゲストは担当ペットのプロフィール＋期間内の共有記録のみ閲覧 | guest | S4 / #93（D8） | ✅ | 既定 deny（`guest_visible`）。`/guest` に担当ペットと期間内の共有記録＋自分の記入のみ表示。写真・他情報・他ペットは不可視。RLS が一次防衛線 |
| UC-G03 | ゲストは期間内に担当ペットの記録を追加できる | guest | S4 / #93 | ✅ | `/guest/records/new`（テキスト・日付・体重。写真/タグはゲスト対象外）。追加は自身の記入のみ・対象ペット・期間内。RLS `records_insert_guest` が強制 |
| UC-G04 | 期間外/失効でゲストのアクセスが自動無効化される | guest | S4 / #93 | ✅ | `valid_from/valid_to` を `has_guest_access` / `has_guest_record_access`（SECURITY DEFINER）で判定。pgTAP 済 |
| UC-G05 | ゲストは Google 非依存で参加できる | guest | S4+S5（D3） | ✅ | S5 の email/password 認証（UC-O02）で参加可。ゲスト画面は Google 非依存 |
| UC-G06 | ゲストのスコープ外参照・自己昇格が不可能 | 攻撃者 | S4 / #38,#93 | ✅ | pgTAP でクロステナント/スコープ外/自己付与/共有フラグ偽装の遮断を証明（guest_grants_test 28・guest_invites_test 10） |
| UC-G07 | 期間終了後、ゲストの記入は世帯に残りゲストはアクセスを失う | guest/世帯 | S4 / #93（D8） | ✅ | ゲストの記入は世帯に残置（`owner_id`=ゲスト）。失効/期間外でゲスト本人は不可視・不可書。pgTAP 済 |

### E. 共有 — S4 に統合

| ID | ユースケース | アクター | スライス/Issue | 状態 | 受け入れ条件 |
| --- | --- | --- | --- | --- | --- |
| UC-S01 | 既存 `share_links`（匿名 read-only）を廃止し `guest_grants` へ一本化 | owner | S4 / #93（D4） | ✅ | `get_shared_view` を常に無効化・既存リンクを一括失効（`20260705020000`）。/shares は終了案内・ナビから撤去。テーブル・関数の物理 DROP は #117 で完了（`20260705030000`） |
| UC-S02 | 発行済み共有リンクの移行/告知 | owner/運用 | S4（D4） | ✅（暫定） | /shares と /share/[token] に終了案内を表示し viewer/ゲスト招待へ誘導。旧トークンは即時失効（期限を待たない） |
| UC-S03 | 一時的な引き継ぎ共有（read-only）をアカウントベースで表現 | owner→viewer/guest | S3/S4 | ✅ | viewer 招待（S3）or 期間限定ゲスト招待（S4）で代替。匿名リンクは廃止 |
| UC-S04 | 写真を含む共有（旧 share_links は写真非対応だった） | 閲覧者 | S4 / #93 | 🟡 | アカウント前提になったことで署名付き URL をログイン済み配信で扱える。SW 不変条件（private/期限付きをキャッシュしない）と両立 |

### F. マルチテナント移行の残債・非機能 — S1 残 + 横断

| ID | ユースケース | アクター | スライス/Issue | 状態 | 受け入れ条件 |
| --- | --- | --- | --- | --- | --- |
| UC-M01 | Storage パスを household 化する | 全書き込み | S1 手順8 / #44（D9） | ✅ | `{owner_id}/...`→`{household_id}/...`（新規分）。既存オブジェクトは移動せず世帯メンバー読取/削除ポリシーを併存。SW が private/期限付き URL をキャッシュしない不変条件を維持 |
| UC-M02 | `tags` / `record_tags` を household 共有にする | 世帯メンバー | S1 手順7 後半 / #44（D9） | ✅ | 定型タグを世帯で共有（`20260703120100`）。RLS をメンバーシップ判定へ（owner 併存）。他世帯には漏れない（pgTAP 担保）。世帯単位の name 一意制約は household_id 書込のメンバーシップ整合強制（S2 以降）とセットで導入 |
| UC-M03 | `profiles` / `google_credentials` は個人スコープのまま維持 | 個人 | #44（D9） | 🟢 | アカウント設定/認証情報は世帯共有しない。owner_id/auth.users 直結を維持 |
| UC-M04 | `household_id` を NOT NULL 化する | 全業務表 | S1 手順6 / #44（D9） | ✅ | `20260703160000_household_id_not_null.sql`（PR #102/#105）で本番適用済み。セーフティネット・バックフィル → NULL 行ゼロ assert → SET NOT NULL の段階適用 |
| UC-M05 | クロステナント不可侵を回帰検出する | CI | S1 手順5 / #38 | ✅→拡張 | pgTAP を S2/S3/S4 のロール・ゲストにも拡張 |
| UC-M06 | owner_id ⇄ household_id の整合を強制し越境を防ぐ | 攻撃者 | S1 / #44 | ✅ | `is_household_member(household_id, owner_id)` で整合要求（実装済） |
| UC-M07 | 操作の監査ログ（誰が何を変更したか） | owner | Phase 4 / #14 | 💡 | D5 で他人の記録を編集可にしたため監査ニーズ増。Phase 4 ガバナンスへ |

---

## 5. スライス別の並び（依存順）

```
S1 テナント基盤（✅ 手順1-8 完了）
  └→ S2 RBAC（owner/editor/viewer 強制, D5）
        └→ S3 内部招待 + 世帯切替UI（D2）
              ├→ S4 外部ゲスト + 共有一本化（guest_grants, D4/D8）
              └→ S5 公開サインアップ（新世帯 or 招待参加, D3/D7）→ Phase 5 課金
```

- S2 は S1 の RLS ヘルパー（`has_household_role` の `allowed_roles`）を使って role を絞る。シグネチャは用意済み。
- S3 の招待基盤は S4 ゲスト招待に流用する（`role=guest` + スコープ指定）。
- S5 は S1 のテナント分離が済んで初めて安全に開ける。公開は課金（#49）・法務（#50）・濫用対策（#37）と揃える。

---

## 6. 受け入れ条件（フェーズ横断の不変条件）

- 既存データは既定 household にバックフィル済みで、表示が壊れない・ダウンタイム無し（✅）。
- 他 household のデータに一切アクセスできない（pgTAP / 将来 E2E で担保）。
- ロール（owner/editor/viewer）と外部ゲスト（期間・対象限定）は**サーバー側で強制**、クライアント回避不可。
- 移行期間中も `owner_id` ベースのアクセスを弱めない（新旧併存を確認してから切替）。
- service_role に依存しない。Service Worker は private / 期限付き URL をキャッシュしない。
- ¥0 運用（Vercel Hobby + Supabase Free + Google 無料枠）。

---

## 7. 未決事項（次にブラッシュアップする論点）

- **アイデンティティ連携**: **方針確定（#117 §4）**: 同一メールは Supabase の Automatic Linking で 1 アカウントに自動統合される（両系統ともメール検証済みが前提）。手動リンクは `enable_manual_linking = false` で閉じたまま、email 確認必須（`enable_confirmations = true`）を維持する。詳細と公開前の実挙動チェックリストは [identity-linking.md](./identity-linking.md)。多要素等の強化は #35（Phase 4）。
- **UC-H09 世帯削除の UX**: **一部実装（#117 §3）**: owner が**参照データの無い世帯**を削除できる（`delete_own_household` RPC + D6 ガード、`20260705040000`）。**データのある世帯の削除**（エクスポート後のカスケード削除・Storage 完全消去・確認/猶予/監査）は #51（Phase 5）で扱う。
- **UC-H11 ペット削除の連鎖設計**: **決定（2026-07-04 ヒアリング）**: 記録は残す（現状どおり `records.pet_id` は ON DELETE SET NULL。過去の記録は世帯の資産として保持）。S4 の `guest_grants` のペット参照のみ CASCADE にする。
- **通知**: **決定（2026-07-04 ヒアリング）**: 招待の通知メールは実装しない（`/invite/{token}` リンクを LINE 等で手動共有する現方式を維持 = ¥0 運用）。ゲスト期間等の通知も 3.5 では見送り。
- **D10 Drive 原本の所有者**: 共有世帯で editor がアップした写真の原本を owner の Drive に集約するか各自か（Drive 連携＝3.5 後）。
- **UC-S02 既存共有リンクの移行告知**: 匿名廃止に伴い、現利用者（祖父母等）への案内と旧トークン失効の運用。
- **UC-M04 NOT NULL 化のタイミング**: 混在期をいつ閉じるか（本番適用はワンショットで要ローカル検証）。
- **マイルストーン整流**: #45/#46/#47 の GitHub マイルストーンが旧 Phase 4/5 のまま（タイトルの `[Phase 3.5]` が正）。

---

- プロジェクト全体像は [../../README.md](../../README.md)。
- 作業指針は [../../AGENTS.md](../../AGENTS.md) / [../../CLAUDE.md](../../CLAUDE.md)。
</content>
</invoke>
