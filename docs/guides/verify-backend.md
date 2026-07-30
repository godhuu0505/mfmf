# デプロイ済みアプリ・Supabase バックエンドの確認

デプロイされたアプリと Supabase バックエンドが正しく動いているかを確認する手順です。
構成の全体像は [reference/architecture.md](../reference/architecture.md) を参照。

## 1. デプロイ済みフロントエンド（Vercel）

1. [Vercel ダッシュボード](https://vercel.com/dashboard) で mfmf プロジェクトを開く。
2. **Production** の URL（`https://<project>.vercel.app` など）を開く。
3. `/login` でログイン → 一覧 → 新規作成 → 写真添付 → 詳細表示まで動けば正常。
4. ログインできない場合は、Vercel の **Settings > Environment Variables** に
   `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` が
   正しい Supabase プロジェクトの値で設定されているか確認する。

## 2. Supabase バックエンド

[Supabase ダッシュボード](https://supabase.com/dashboard) で対象プロジェクト（`mfmf`）を開く。

| 確認項目 | どこで | 期待状態 |
| --- | --- | --- |
| プロジェクト稼働 | トップ | Status が **ACTIVE / Healthy**。Free は無アクセスで一時停止することがあり、その場合は Restore / Resume。 |
| テーブルと RLS | Table Editor | `public.daycare_records` / `public.record_photos` / `public.feedback` が存在し、いずれも **RLS enabled**。 |
| 認証ユーザー | Authentication > Users | ログインに使うユーザーが存在。**世帯メンバーはそれぞれ自分のアカウント**を持つ（招待で追加。`SIGNUP_ENABLED` が閉じている間は手動発行）。 |
| 世帯とロール | Table Editor | `households` / `household_members` が存在し RLS enabled。確認したいユーザーの `household_members` 行と `role`（owner/editor/viewer）が意図どおり。 |
| テナント分離・ロール境界 | **CI（pgTAP）＋ SQL Editor** | **挙動**は `supabase/tests/` が PR ごとに検証済み。**本番では挙動を試さず、`pg_policies` でポリシー定義が一致しているかを読む**（→ §2-1）。 |
| Storage | Storage ＋ **SQL Editor** | `daycare-photos` バケットがあり **private**。署名付き URL（期限 1 時間）で配信。**バケットの存在だけでは不十分**で、`storage.objects` のポリシーも読む（→ §2-1）。 |
| スキーマ適用 | （実体で判断） | 上の実体が揃っていれば適用済み。未適用なら **`supabase db push`**（CLI）で適用する。SQL Editor で流した場合は履歴が残らないので `supabase migration repair --status applied <version>` を忘れないこと（下の ⚠️）。 |
| advisor | Advisors | RLS 未設定や危険な公開設定の警告が **0 件**。DDL 変更後は必ず確認。 |

> ⚠️ **Database > Migrations の履歴**。CI/CD の `migrate` ジョブが `supabase db push` で適用した
> migration は **`supabase_migrations.schema_migrations`** に履歴が残るので、Actions の run と
> 突き合わせて確認できる（[guides/deploy.md](./deploy.md)）。一方、過去に **SQL Editor で実行した分**
> や初回 setup で手動適用した分は履歴に残らないため、移行期は実体（テーブル / ポリシー / バケット）と
> 履歴の両面で判断する。ズレを直したいときは `supabase migration repair --status applied <version>` を使う。

### 2-1. 挙動は pgTAP に任せ、本番では「定義」を読む

**テナント分離とロール境界の検証は、書くと壊れます。** このリポジトリでは実際に
「確認したのに何も検証できていない」手順を 2 度作りました。

- アプリ画面で別世帯のユーザーを開いて確認する → `src/app/page.tsx` が RLS の**手前**で
  `householdScopeFilter(householdId)` を掛けている（`src/lib/household.ts`）。
  本番のポリシーが全世帯を許していても、画面には自分の世帯の行しか出ない
- JWT を取って API を直接叩く → 認証に失敗すると `Bearer null` で問い合わせることになり、
  **空が返って「分離できている」ように見える**。加えて本番の資格情報を手元で扱う必要が出る

**恒久的な担保は CI の pgTAP（`supabase/tests/`）です。** 8 ファイル・**159 アサーション**
（`results_eq` 68 / `throws_ok` 49 / `lives_ok` 20 / `is_empty` 12 / `ok` 10）で、
手動確認より広く深く検証しています。

| 検証されていること | ファイル |
| --- | --- |
| 他世帯の record / pet / photo / feedback が select 不可、update も no-op | `household_rls_test.sql` |
| viewer は update / delete できず insert は throw（UC-A01） | `household_rbac_test.sql` |
| ゲストは対象ペット・期間の外を見られない | `guest_grants_test.sql` |
| 招待・世帯作成・削除・Storage・タグの各境界 | `household_invites_test.sql` ほか |

これらは **PR ごとに CI で走ります**（`.github/workflows/ci.yml` の
`RLS tenant isolation (pgTAP)`）。**挙動を手元で本番に対して試す必要はありません。**

### 本番で確認すること —— ポリシーの「定義」を読む（read-only）

**pgTAP はローカルの使い捨てスタックに対して走ります**（`.github/workflows/ci.yml` の
`supabase start` → `supabase test db`）。つまり検証しているのは
**「migration どおりに作れば正しく守られる」**ことです。
本番の migration 適用漏れ・手で書き換えたポリシー・失敗したデプロイは、**これでは分かりません**。

そこで本番側は、SQL Editor で**ポリシーの定義そのものを読みます**。read-only で、
アプリの資格情報を使わず、**write を一切しません**。

```sql
-- 本番の Supabase ダッシュボード > SQL Editor で実行（SELECT のみ）
select schemaname, tablename, policyname,
       cmd,
       permissive,        -- ← 'PERMISSIVE' であること（RESTRICTIVE は AND 結合になる）
       roles,             -- ← {authenticated} 等。誰に適用されるか
       qual, with_check
from pg_policies
where schemaname in ('public', 'storage')   -- ← 写真のポリシーは storage.objects にある
order by schemaname, tablename, policyname;
```

> ⚠️ **`schemaname = 'public'` だけで絞らないこと。** 写真の実体を守っているのは
> **`storage.objects` のポリシー**（`20260703120000_storage_household_paths.sql`）で、
> これは `storage` スキーマにあります。`public` だけ見ると、**バケットのポリシーが
> 消えていても・手で緩められていても、この手順は「本番は pgTAP と一致」と結論します**。
> `daycare-photos` は private なので配信は署名付き URL 経由ですが、**署名の発行自体に
> select の RLS が必要**なため、ここが緩むと他世帯のユーザーが署名を取れるようになります。

**確認するのは 5 点**です。

1. **`permissive` と `roles`** —— 名前・`cmd`・述語がすべて一致していても、
   この 2 列が違うと**適用のされ方が変わります**。
   - `permissive` が `RESTRICTIVE` に作り直されていると、PostgreSQL は
     **OR ではなく AND** で結合します。同じ述語でも他のポリシーと掛け算になり、
     正当な世帯アクセスが**拒否される**（穴が開くのではなく機能が壊れる方向）
   - `roles` が変わっていると、意図した相手にポリシーが適用されません
     （全許可にはなりません —— 他に許可が無ければ拒否です）

   **期待値は `permissive = 'PERMISSIVE'` / `roles = {public}` です。**
   本リポジトリの migration は `TO` 句を書いておらず（128 本の `create policy` すべて）、
   判定は述語の `auth.uid()` 側で行っています。したがって `{authenticated}` ではなく
   **`{public}` が正常**です —— ここを「`public` は危ない」と読み替えて `TO` を足すと、
   ポリシーの適用対象が狭まって正当なアクセスが落ちます
2. **世帯データのテーブルが世帯ヘルパーを経由しているか** —— `qual` / `with_check` に
   `has_household_role` / `is_household_member` / `has_guest_access` /
   `has_guest_record_access` のいずれかが現れること。
   `true` だけのポリシーや、`household_id` を見ていない条件があれば**そこが穴**。

   ⚠️ **ただし「世帯ヘルパーが無い＝穴」ではありません。** `profiles` と
   `google_credentials` は**ユーザー単位**のテーブルで、`household_id` を持たず、
   正しい述語は `auth.uid() = owner_id` です（`20260616130708_profiles.sql` /
   `20260616130711_google_credentials.sql`）。この 2 つは**世帯で共有してはいけない**
   —— とくに `google_credentials` は Google の OAuth トークンなので、
   ここを世帯ヘルパーに「直す」と**世帯メンバーが互いの refresh token を読めます**。
   `*_own` という名前と `auth.uid() = owner_id` の組み合わせが出たら、それが正常です
3. **`cmd` の欠落を「適用漏れ」と決めつけないこと** —— 欠けている `cmd` は、
   その操作が「ポリシー無し」＝ RLS 有効なら全拒否になることを意味します。
   これは**多くの場合、意図した最小権限**です。実際に migration どおりの状態でも:

   | テーブル | 無い `cmd` | 理由 |
   | --- | --- | --- |
   | `record_photos` / `record_tags` | **update 無し** | 写真・タグ付けは付け外しのみ（差し替えは delete + insert） |
   | `households` | **insert / delete 無し** | 作成・削除は RPC（`create_own_household` / `delete_own_household`）が担う |
   | `household_members` | **insert 無し** | メンバー追加は招待フロー（`accept_household_invite`）だけを経路にしている |

   🚨 **足りないように見えるからといってポリシーを追加しないこと。** 上の 3 つに
   insert / update を足すと、RPC と招待フローを迂回する経路を自分で開けることになります。
   期待する `cmd` の集合は `supabase/migrations/` が正で、5 点目で突き合わせます。
   **RLS が無効になっていれば全許可**になりますが、それは下の表の「RLS enabled」で気づけます
4. **`storage.objects` に `daycare_photos_*` の 5 本が揃っているか** —— 2 系統です。
   `_household`（新パス規約 `{household_id}/...` 用: select / insert / delete）と
   `_shared_owner`（旧パス `{owner_id}/...` を「その記録の世帯のメンバー」に開く分:
   select / delete）。`qual` に `is_household_member` / `has_household_role` と
   `public.try_cast_uuid(...)`（パス先頭セグメントの安全なキャスト）が現れること。
   **`bucket_id = 'daycare-photos'` の条件が消えていれば、他バケットまで巻き込みます**

   > `_own`（`daycare_photos_{select,insert,delete}_own`）は**もう存在しません**。
   > `20260704000000_rbac_switch_and_management.sql` と
   > `20260704020000_member_exit_and_h10.sql` で drop されています
   > （旧パスの読み取りは `_shared_owner` が世帯単位で引き継いだ）。
   > **1 本のポリシーの有無を数えるときは、それを作った migration だけでなく
   > 後続の drop まで追うこと** —— この節は一度「8 本」と書いて間違えました
5. **`supabase/migrations/` の内容と一致するか** —— 差異があれば適用漏れか手動変更。
   `supabase migration list` で履歴のズレも確認できる（[deploy.md](./deploy.md)）

**さらに、ヘルパー関数の中身も比べます。** `pg_policies` に出るのは
`has_household_role(...)` / `try_cast_uuid(...)` という**呼び出しだけ**で、
関数の**本体**は含まれません。メンバーシップ・ロール・対象ペット・期間の判定も、
Storage パスの先頭セグメントの解決も、すべて**本体の中**にあります。
つまり **`has_household_role` が `return true` に書き換えられていても、上の 5 点は全部通ります** ——
そしてその 1 行で全世帯が露出します。

```sql
-- public の関数を「全部」出して確認する（名前でも属性でも絞らない）
select p.proname,
       p.prosecdef               as security_definer,
       p.proconfig               as settings,     -- search_path が空に固定されていること
       pg_get_functiondef(p.oid) as definition
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
order by p.prosecdef desc, p.proname;
```

🚨 **`prosecdef` で絞らないこと。** この手順は 2 度、絞り込みで対象を落としています。

1. 最初は `proname in (...)` で **4 つを手で並べて**いて、RLS 述語から呼ばれる
   `has_guest_access` が漏れていました
2. 次に `p.prosecdef` で絞ったところ、**`SECURITY INVOKER` のヘルパーが漏れました** ——
   `public.try_cast_uuid` は `20260703120000_storage_household_paths.sql:55` で
   invoker として定義され、**`storage.objects` の 5 本すべてから直接呼ばれています**。
   本体が固定の UUID を返すように書き換えられると、**どのパスの先頭セグメントも
   その世帯として解決される** —— つまりその世帯のメンバーが**無関係な写真を
   select / 署名発行できる**のに、ポリシー側の確認は全部通ります

絞り込みの条件を考えた時点で「その条件から外れるもの」が生まれます。**全部出すのが唯一
漏れない形**です。実際に引くと **13 個**（`SECURITY DEFINER` 10 個 ＋ invoker 3 個）出ます。

| 種類 | 関数 | なぜ重要か |
| --- | --- | --- |
| **RLS 述語から呼ばれる（definer）** | `has_household_role` / `is_household_member` / `has_guest_access` / `has_guest_record_access` | ここが `return true` になると**ポリシー式が正しく見えたまま全世帯が露出** |
| **ポリシーから呼ばれる（invoker）** | `try_cast_uuid` | 固定 UUID を返すと**全パスが同じ世帯に解決される**（上記2） |
| RPC（definer） | `accept_household_invite` / `create_own_household` / `delete_own_household` / `get_household_members` / `get_household_guests` | 招待・世帯作成/削除の経路そのもの |
| トリガ（definer / invoker） | `enforce_last_owner` / `forbid_owner_change` | RLS で表現できない不変条件（→ 次節） |

出てきた各関数の `definition` を `supabase/migrations/` の該当 SQL と見比べ、
`settings` に **`search_path=`（空に固定）**が入っていることを確認します。
本リポジトリのヘルパーは `set search_path = ''` で参照は全て完全修飾名
（`20260630140000_household_rls_helper.sql`）。この固定が外れていると、関数内の名前解決を
差し替えられる余地が生まれます。`security_definer` 列が `true` のものは
**呼び出し元の権限を無視して実行される**ので、本体の判定がそのまま境界になります。

### そして、トリガの「付き方」も確認します（関数一覧だけでは分からない）

**RLS で表現できない不変条件が 2 つあり、どちらもトリガが担っています。**
ポリシーもヘルパーも一致していて、なおここだけ壊れている状態があり得ます。

| 何を守っているか | 関数 | 付いている先 |
| --- | --- | --- |
| **`owner_id` の書き換え禁止**（記入者の偽装防止） | `forbid_owner_change()` | `daycare_records` / `pets` / `tags` / `feedback` の update |
| **世帯の最後の owner を失わせない** | `enforce_last_owner()` | `household_members` の update / delete |

`forbid_owner_change()` が RLS で代替できない理由は `20260704020000_member_exit_and_h10.sql`
に書かれています —— **update の `USING` / `WITH CHECK` は「更新後の行が条件を満たすか」しか見ず、
`owner_id` が別の値に**差し替えられた**ことは判定できない**ためです。
editor は自分の世帯の行を正当に update できるので、`owner_id` だけを他人の id に
書き換える操作はポリシー上は通ってしまいます。

**関数の一覧に出てくるだけでは足りません。** 上のクエリは `public` の関数を全部出すので
`forbid_owner_change` の**本体**は確認できますが、それが**どのテーブルの何の操作に
付いているか**、そして**有効かどうか**は出てきません。トリガが外されていれば、
関数は正しいまま不変条件だけが消えます。

```sql
-- トリガの「付いていること」と「有効であること」を確認する（名前を書き並べない）
select c.relname          as table_name,
       t.tgname           as trigger_name,
       t.tgenabled        as enabled,      -- 'O' = 有効。'D' なら**無効化されている**
       pg_get_triggerdef(t.oid)  as trigger_def,   -- ← before/after と insert/update/delete
       p.proname          as function_name,
       pg_get_functiondef(p.oid) as definition
from pg_trigger t
join pg_class c     on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
join pg_proc p      on p.oid = t.tgfoid
where n.nspname = 'public'
  and not t.tgisinternal          -- ← 外部キー等の内部トリガを除く
order by c.relname, t.tgname;
```

確認するのは **4 点**です。

1. **上の表の 5 つの付け先すべてに行があるか**（`forbid_owner_change` が 4 テーブル、
   `enforce_last_owner` が `household_members`）
2. **`enabled` が `'O'` か** —— `alter table ... disable trigger` は**ポリシーも関数定義も
   一切変えずに**不変条件だけを外せます。定義を読むだけでは気づけないのはここです
3. **`trigger_def` の発火条件が一致しているか** —— **名前と関数が合っていても、
   発火するイベントが違えば守っていません**。`forbid_owner_change` は
   `before update`、`enforce_last_owner` は `before update or delete` です。
   たとえば前者が `before insert` に、後者が `before update` だけに作り直されていると、
   表示される名前・`enabled`・関数本体はすべて一致したまま、
   **`owner_id` の書き換えや「最後の owner の削除」が通ります**
4. **`definition` が migration と一致するか**（`forbid_owner_change` は
   `20260704020000_member_exit_and_h10.sql`、`enforce_last_owner` は
   `20260705040000_household_delete.sql` が最新）

> `share_links` にも同じトリガが付いていましたが、`20260705030000_drop_share_links.sql` の
> `drop table ... cascade` でテーブルごと消えています（D4 の匿名共有廃止）。
> **`cascade` はトリガも一緒に落とすので、migration の `create trigger` を数えると 5 件に
> 見えますが、生きているのは 4 件です。** 上のクエリで実際に引けば取り違えません。

> これは**挙動ではなく定義**の確認です。挙動は pgTAP が担保しているので、
> ここでは「本番に載っている定義が、pgTAP が検証した定義と同じか」だけを見ます。
> **ポリシーとヘルパー本体の両方**が一致していて pgTAP が緑なら、本番の挙動も同じと言えます。
> 片方だけでは足りません —— ポリシーが正しく見えてもヘルパーが嘘をついていれば素通りします。

あわせて上の表の「テーブルと RLS」（RLS enabled）「世帯とロール」「advisor」も確認します。

> ⚠️ **本番データに対して write を試さないこと。** 「viewer で書けないことを確かめる」形の
> 手動テストは、RLS が壊れていた場合に**本番へ書き込んでしまいます**。
> 壊れているかどうかを確かめる操作が、壊れていたときに被害を出す形になっています。
> 同じことは pgTAP がローカルの使い捨て DB で安全に検証済みです。


## 3. 接続のスモークテスト

「フロントが正しい Supabase に繋がっているか」を最短で確認する方法。

1. デプロイ済みアプリ（または `npm run dev`）でログインする。
2. 記録を 1 件作成し、写真を 1 枚添付する。
3. Supabase の **Table Editor** で `daycare_records` / `record_photos` に行が増え、
   **Storage** の `daycare-photos` に画像が保存されていれば、フロント ↔ バックエンドの接続は正常。

> RLS により他人のデータは見えないため、判断はブラウザのコンソールではなく
> Supabase ダッシュボード側にデータが反映されるかで行うのが確実。

環境変数の対応表は [reference/configuration.md](../reference/configuration.md) を参照。
