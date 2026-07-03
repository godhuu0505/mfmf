# ビジョンと機能ロードマップ

mfmf を「夫婦2人の最小記録アプリ」から、**ペットのケアに関わる人がつながる共有プラットフォーム**へ
育てるための構想メモです。本書は **概要カタログ**（どんな機能があるかの一覧）であり、各機能の詳細仕様・
スキーマ・RLS は採用が決まった時点で個別ドキュメント／migration に落とします。

- 現状の「何が」あるかは [reference/architecture.md](../reference/architecture.md)
- 現状の「なぜ」は [design-decisions.md](./design-decisions.md)
- DB / RLS の正は [`supabase/migrations/`](../../supabase/migrations/)

> ⚠️ 本書は将来構想を含みます。ここに書かれた機能の多くは **未実装** です。実装状況は各表の「状態」列を参照。

---

## 1. ゴールの進化

| | フェーズ1（現状） | これから（本書の構想） |
| --- | --- | --- |
| 利用者 | 夫婦2人・1アカウント共用 | 家族＋外部（保育園・ペット/ベビーシッター）が**各自のアカウント**で参加 |
| 共有方針 | (A) `owner_id = auth.uid()` 一本 | (B+) **家族（family）× メンバー × ペットの多対多** ＋ 権限（role） |
| 写真 | Supabase Storage（private） | **原本は Google Drive・サムネだけ Supabase**（容量節約） |
| 守備範囲 | 記録（テキスト＋写真）の CRUD | 記録＋**予定・予防接種リマインダー・レポート・アルバム** |
| 立ち位置 | 単機能アプリ | **Google サービス（Drive / Calendar / Photos…）を束ねるハブ** |

新しい一文ゴール:

> **ペットのケアに関わる人が、適切な権限でつながり、記録・写真・予定・健康情報を一か所で扱える。
> その裏側でバラバラな Google サービスを一元的に束ねる、無料運用のハブ。**

「芯」として **引き継ぐ不変条件**（[design-decisions.md](./design-decisions.md) 参照）:

- セキュリティの一次防衛線は **RLS**（multi-tenant 化後も維持）
- Service Worker は **private・期限付き URL をキャッシュしない**
- ¥0 運用（Vercel Hobby + Supabase Free + Google 無料枠）

**新たに増える前提**（要設計）:

- Google OAuth の **リフレッシュトークン＝サーバー秘密** を持つ必要が出る（現状の「anon key だけ」から一段重くなる）
- 外部関係者（保育園・シッター）の **スコープ限定・期間限定アクセス** という新しい権限概念

---

## 2. ステークホルダーと権限モデル（3段階＋外部ゲスト）

採用済みの内部 role に加え、外部関係者を**スコープ／期間を絞ったゲスト**として招く。

| role | 想定 | できること（概要） |
| --- | --- | --- |
| **owner** | 飼い主（夫婦） | 家族・メンバー管理、招待、すべての記録/予定の編集、削除 |
| **editor** | 同居家族・主たる世話人 | 記録・予定・写真の追加/編集、ペット情報の編集 |
| **viewer** | 祖父母など | 閲覧のみ |
| **guest:daycare** | 保育園 | **担当ペット・指定期間だけ** 記録の追加と閲覧。家族の他情報は見えない |
| **guest:sitter** | ペット/ベビーシッター | 同上（預かり期間だけ・対象ペットだけ） |

> 外部ゲストは「期間（from/to）」と「対象ペット」でスコープを絞るのが肝。RLS は内部 role 用の
> `has_household_role()` に加え、**ゲスト用の付与テーブル（期限・対象付き）** を別途参照する設計を想定。
> 詳細・実装単位は Issue [#91（Phase 3.5）](https://github.com/godhuu0505/mfmf/issues/91) の S2 / S4 で管理。

---

## 3. データモデル概要（multi-tenant）

詳細は採用時に migration 化。骨格のみ:

```
households        (id, name)
household_members (household_id, user_id, role)          -- 内部メンバーの多対多
guest_grants      (household_id, user_id, scope_pet_id,  -- 外部ゲストの期間/対象限定アクセス
                   role, valid_from, valid_to)
household_invites (id, household_id, email/code, role, expires)
pets              (id, household_id, name, species, birthday, avatar_path)
daycare_records   (… household_id / pet_id を追加。owner_id は移行期間中"残す"＝無停止移行)
record_photos     (… household_id 追加。drive_file_id + thumb_path) -- 原本Drive・サムネSupabase
events            (id, pet_id, kind, start_at, end_at,   -- 予定・予防接種・通院
                   google_event_id, remind_at)
```

> 実装上のテーブル/列名は migration と Issue（[#91 Phase 3.5](https://github.com/godhuu0505/mfmf/issues/91)）に合わせて
> **`household` 系**（`households` / `household_members` / `household_invites` / `household_id`）に統一する。
> 「家族」は日本語 UI 上の呼称で、内部識別子は household。`CLAUDE.md` の「DB/RLS は migration を正とする」方針に従う。

- **多対多**：`household_members` でユーザーは複数 household に所属可。`pets.household_id` で household は複数ペットを保有。
- **「1匹を複数 household で共同管理」** まで踏み込むなら `pets` も junction 化（`pet_households`）して "多々々" に拡張可能（やりすぎ注意点）。

---

## 4. Google サービス統合ハブ（方針）

「Google に既にある機能がバラバラ」を、mfmf が**横断 UI ＋ 一元管理**で束ねる。

| Google サービス | mfmf での役割 | 状態 |
| --- | --- | --- |
| **Drive** | 写真原本の保管庫（15GB 枠）。サムネのみ Supabase | 🟢 採用（Phase 3.5 後） |
| **Calendar** | 予定・予防接種・通院を家族カレンダーへ双方向同期 | 🟢 採用（Phase 3.5 後） |
| **OAuth (ログイン)** | 家族・外部が各自アカウントで参加 | ✅ 実装済（公開サインアップは Phase 3.5 / S5） |
| **Tasks / Reminders** | 「フィラリア予防」等の繰り返しリマインダー | 検討 |
| **Photos** | 既存アルバム連携（※API 制約が強いので慎重に） | 検討 |
| **Gmail** | 保育園からの連絡メール取り込み | 将来 |

**横断 UI のイメージ**：アプリのカレンダー画面＝Google Calendar の該当ペット予定、記録の写真＝Drive 上の原本、
リマインダー＝Tasks…をそれぞれ別タブで開かずに mfmf 内で見る・操作する。

> 不変条件との折り合い：Drive 原本は**アプリ経由プロキシ配信**で private を死守。Calendar 同期は
> トークン管理が増える点を、Drive / Calendar 連携（Phase 3.5 後）の着手前に別途設計する。

---

## 5. 機能カタログ（一覧）

状態凡例：✅実装済 / 🟢採用（ロードマップ確定）/ 🟡検討 / 💡将来

### A. 記録（コア）
| 機能 | 概要 | 状態 |
| --- | --- | --- |
| 記録 CRUD | 日付＋本文の作成/一覧/詳細/編集/削除 | ✅ |
| 写真の紐付け | 1記録に複数枚 | ✅ |
| 記録メタデータ | 記録元(🏫/🏠)・記入者・体重 | ✅ |
| ペット単位の記録 | `pet_id` で複数ペットを区別 | 🟢 |

### B. 入力体験（続けやすく）
| 機能 | 概要 | 状態 |
| --- | --- | --- |
| 定型テンプレ | 「ごはん完食」等をタップで本文挿入。家族ごとに編集可 | 🟢 |
| 音声入力 | ブラウザ標準 Web Speech API で口述記入 | 🟢 |
| ホームから1タップ記入 | PWA ショートカット＋写真の共有ターゲット受け取り | 🟢 |
| 前回値プリフィル | ペット/記録元/記入者を前回値で既定化 | 🟢 |
| 写真ドリブン入力 | 写真→EXIF で日付補完→一言だけ | 🟡 |
| クイック記録 | ごはん/トイレ/散歩をボタンタップだけで構造化記録 | 🟡 |
| オフライン下書き | IndexedDB に下書き保存→オンライン時に同期 | 🟡 |

### C. 振り返り体験
| 機能 | 概要 | 状態 |
| --- | --- | --- |
| 全文検索 | 本文を検索。ペット/記録元/期間/記入者で絞り込み | 🟢 |
| カレンダー / 月まとめ | 記録のある日をハイライト→タップで遷移 | 🟢 |
| 「○年前の今日」 | ホーム最上部に過去の同月日をそっと表示 | 🟢 |
| 健康グラフ拡張 | 体重をペット単位に。通院/ワクチンのマーカー | 🟢 |
| 写真アルバム | 記録横断の写真グリッド（ペット別） | 🟢 |
| タグ / マイルストーン | `#お散歩` `#初めて` で軸を増やす・ピン留め | 🟡 |
| 月次ダイジェスト | 今月のまとめ（写真ベスト＋体重＋トピック）。将来 AI 要約 | 🟡 |

### D. 予定・日程調整（カレンダー）
| 機能 | 概要 | 状態 |
| --- | --- | --- |
| 予定の登録 | 通院・トリミング・預かり日などをペットに紐付け | 🟢 |
| Google Calendar 同期 | 家族カレンダーと双方向。各自の端末通知に乗せる | 🟢 |
| 日程調整 | 預かり日などの候補出し・家族/シッター間の調整 | 🟡 |

### E. リマインダー（健康管理）
| 機能 | 概要 | 状態 |
| --- | --- | --- |
| 予防接種の予定 | 次回ワクチン日を登録・通知 | 🟢 |
| 繰り返し予防 | フィラリア・ノミダニ等の周期リマインダー | 🟢 |
| 通院・服薬 | 通院履歴と服薬リマインダー | 🟡 |

### F. レポーティング
| 機能 | 概要 | 状態 |
| --- | --- | --- |
| 期間レポート | 「今月」「預かり期間」の記録・写真・体重をまとめて出力 | 🟢 |
| 共有レポート | 保育園/シッター向けの引き継ぎシート（閲覧 or PDF） | 🟡 |
| 健康サマリー | 体重推移・通院・接種履歴を1枚に | 🟡 |

### G. アルバム / 写真
| 機能 | 概要 | 状態 |
| --- | --- | --- |
| Drive 原本保管 | 原本を Google Drive、サムネを Supabase | 🟢 |
| アルバム表示 | ペット別・期間別の写真グリッド | 🟢 |
| 共有アルバム | 家族・祖父母と権限内で共有 | 🟡 |

### H. 共有・権限
| 機能 | 概要 | 状態 |
| --- | --- | --- |
| Google ログイン | 各自アカウントで参加 | 🟢 |
| 家族（family）と多対多メンバー | 複数家族に所属可能 | 🟢 |
| 3段階 role | owner / editor / viewer | 🟢 |
| 招待フロー | メール/リンクで招待・受諾 | 🟢 |
| 外部ゲスト | 保育園・シッターを期間/対象限定で招く | 🟢 |

### I. データ保全・基盤
| 機能 | 概要 | 状態 |
| --- | --- | --- |
| エクスポート | 記録＋写真を ZIP/JSON で書き出し（思い出の単一障害点対策） | 🟢 |
| 孤児ファイル掃除 | DB 未登録の Storage/Drive 画像を回収 | 🟢 |
| `deletePhoto` 認可修正 | `getUser()` を追加し規約逸脱を解消 | 🟢 |
| 自動テスト | RLS の回帰を検出する仕組み | 🟡 |

---

## 6. フェーズ別ロードマップ

各機能を「壊さない段階移行」で並べる（RLS は命綱なので無停止移行を優先）。
**正のトラッキングは GitHub Issues のエピック**。本表は俯瞰用のスナップショット。

| Phase | テーマ | 主な内容 | エピック |
| --- | --- | --- | --- |
| **3** | PM 基盤（計測・意思決定） | エラーモニタリング（Sentry）・Web Vitals・フィードバック整備 | [#13](https://github.com/godhuu0505/mfmf/issues/13) |
| **3.5** | **家族・権限・マルチテナント基盤（→ 公開サインアップ）** | household データモデル + メンバーシップ RLS 無停止移行 → RBAC → 招待 → 外部ゲスト → 公開サインアップ | [#91](https://github.com/godhuu0505/mfmf/issues/91) |
| **4** | セキュリティ / ガバナンス & 開発速度 | 監査ログ・MFA・CSP・レート制限・pgTAP / E2E・Feature Flag・依存自動更新 | [#14](https://github.com/godhuu0505/mfmf/issues/14) |
| **5** | 一般公開 & マネージドプラン（課金） | Stripe（Free/Pro）・法務・エクスポート/削除・可用性/SLA・計測/KPI | [#15](https://github.com/godhuu0505/mfmf/issues/15) |

> **番号体系について**: 本書の旧版は独自の Phase 0〜5（足場固め / 家族とログイン / 体験 quick win / 権限と招待 / Drive / 予定 / レポート）で並べていたが、
> 実作業の追跡は GitHub のエピック番号（#13 / #91 / #14 / #15）を正とする方針に統一した。旧 Phase の機能カタログ（Drive・Calendar・レポート・ハブ統合）は
> §4・§5 に温存しており、**Phase 3.5 でマルチテナント化を終えた後**に続く位置づけ（multi-tenant が前提のため）。

### Phase 3.5 のスライス分割（[#91](https://github.com/godhuu0505/mfmf/issues/91)）

> ユースケース単位の洗い出し・受け入れ条件・設計決定ログは
> [phase-3-5-use-cases.md](./phase-3-5-use-cases.md) を参照。

「家族・権限が先 → 公開サインアップが後」という依存順を 1 エピックに束ねた。旧構成では household 移行が Phase 4（#33）、
サインアップが Phase 5（#47）に分散していたものを、**ゼロベースで再構成**したもの。最も危険な `owner_id` → household の
RLS 作り替えを **n=2 のうちに**済ませるのが核。

機能を 1 列に並べず、共通土台（S1）の上の **2 軸**で考える。

```
              ┌───────────────────────────────────┐
              │  S1: household データモデル          │
              │      + メンバーシップ RLS（無停止）   │ ← n=2 の今に実施
              └───────────────────────────────────┘
                       ↑                    ↑
        軸A（深さ: 1 世帯に人を増やす）   軸B（広さ: 世帯を増やす）
        S2 RBAC → S3 招待 → S4 ゲスト    S1 テナント分離 → S5 サインアップ → 課金(Phase 5)
```

| スライス | 内容 | 出すタイミング | Issue |
| --- | --- | --- | --- |
| **S1 テナント基盤** | `households` / `household_members` 追加、`household_id` バックフィル、メンバーシップ RLS を `owner_id` と**併存→切替**、pgTAP で分離証明 | **n=2 の今（最優先）** | [#92](https://github.com/godhuu0505/mfmf/issues/92)（[#43](https://github.com/godhuu0505/mfmf/issues/43) / [#44](https://github.com/godhuu0505/mfmf/issues/44) / [#38](https://github.com/godhuu0505/mfmf/issues/38)） |
| **S2 RBAC** | owner / editor / viewer のロール強制（サーバー側） | S1 直後 | [#46](https://github.com/godhuu0505/mfmf/issues/46) |
| **S3 内部招待** | 招待トークン → メンバー追加 / 削除 / 退出 | S2 直後 | [#45](https://github.com/godhuu0505/mfmf/issues/45) |
| **S4 外部ゲスト** | 保育園 / シッターを期間・対象ペット限定で招く | 価値次第（後ろ倒し可） | [#93](https://github.com/godhuu0505/mfmf/issues/93) |
| **S5 公開サインアップ** | セルフ登録 → household 作成 → owner 化 → オンボ | Phase 5 課金と並走 | [#47](https://github.com/godhuu0505/mfmf/issues/47) |

> 旧 #48「マルチテナント完全移行」は独立フェーズにせず、**S1 の受け入れ条件**（pgTAP [#38](https://github.com/godhuu0505/mfmf/issues/38)）に吸収した
> （独立フェーズに残すと移行を二度やる構図になるため）。
>
> 旧 Phase 0「足場固め」（`deletePhoto` 認可修正・エクスポート・孤児ファイル掃除）と Phase 1.5「体験 quick win」は本エピックの前提ではなく、
> §5 機能カタログの該当項目として独立に進める。

---

## 7. 未決事項（次回以降に詰める）

- **Google トークンの保管方式**：Supabase の provider token か、暗号化列＋Edge Function か。
- **外部ゲストの RLS 設計**：`guest_grants` の期間/対象スコープをどう RLS に落とすか。
- **Drive 原本の配信方式**：アプリ経由プロキシ（private 維持）の実装コストと SW 不変条件の両立。
- **1匹を複数家族で共同管理**（`pet_families`）まで踏み込むか（スコープ肥大の懸念）。
- **AI 機能**（月次要約など）を Claude API で入れるかどうか（コストと ¥0 方針の折り合い）。
</content>
</invoke>
