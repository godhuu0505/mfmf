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
select schemaname, tablename, policyname, cmd, qual, with_check
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

**確認するのは 4 点**です。

1. **世帯ヘルパーを経由しているか** —— `qual` / `with_check` に
   `has_household_role` / `is_household_member` / `has_guest_access` /
   `has_guest_record_access` のいずれかが現れること。
   `true` だけのポリシーや、`household_id` を見ていない条件があれば**そこが穴**
2. **`daycare_records` / `record_photos` / `pets` / `feedback` / `households` /
   `household_members` / `guest_grants` に select / insert / update / delete が揃っているか** ——
   欠けている `cmd` があれば、その操作は「ポリシー無し」＝ RLS 有効なら全拒否、
   無効なら全許可になる（後者は下の RLS enabled の行で気づける）
3. **`storage.objects` に `daycare_photos_*` の 8 本が揃っているか** —— 3 系統あります。
   `_own`（旧パス規約 `{owner_id}/...` 用: select / insert / delete）、
   `_household`（新パス規約 `{household_id}/...` 用: select / insert / delete）、
   `_shared_owner`（旧パスを世帯メンバーに開く分: select / delete）。
   `qual` に `is_household_member` / `has_household_role` と
   `public.try_cast_uuid(...)`（パス先頭セグメントの安全なキャスト）が現れること。
   **`bucket_id = 'daycare-photos'` の条件が消えていれば、他バケットまで巻き込みます**
4. **`supabase/migrations/` の内容と一致するか** —— 差異があれば適用漏れか手動変更。
   `supabase migration list` で履歴のズレも確認できる（[deploy.md](./deploy.md)）

**さらに、ヘルパー関数の中身も比べます。** `pg_policies` に出るのは
`has_household_role(...)` という**呼び出しだけ**で、関数の**本体**は含まれません。
これらは `SECURITY DEFINER`（呼び出し元の権限を無視して実行）で、
メンバーシップ・ロール・対象ペット・期間の判定は**本体の中**にあります。
つまり **`has_household_role` が `return true` に書き換えられていても、上の 3 点は全部通ります** ——
そしてその 1 行で全世帯が露出します。

```sql
-- SECURITY DEFINER の関数を「列挙して」確認する（名前を書き並べない）
select p.proname,
       p.proconfig               as settings,     -- search_path が空に固定されていること
       pg_get_functiondef(p.oid) as definition
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prosecdef                                -- ← SECURITY DEFINER のものを全部
order by p.proname;
```

**関数名を列挙する形にしないこと。** 実際に `prosecdef` で引くと、RLS から呼ばれる
`has_household_role` / `is_household_member` / `has_guest_access` / `has_guest_record_access`
のほか、RPC 側の `accept_household_invite` / `create_own_household` / `delete_own_household` /
`get_household_members` / `get_household_guests`、トリガの `enforce_last_owner` まで出ます。
**手で名前を並べると、増えたぶんが確認対象から漏れます**（この手順は実際に
`has_guest_access` を落としていました）。`prosecdef` で引けば漏れません。

出てきた各関数の `definition` を `supabase/migrations/` の該当 SQL と見比べ、
`settings` に **`search_path=`（空に固定）**が入っていることを確認します
（`prosecdef` で絞っているので、出てきたものはすべて SECURITY DEFINER です）。
**RLS の述語から呼ばれる 4 つ**（`has_household_role` / `is_household_member` /
`has_guest_access` / `has_guest_record_access`）は特に重要で、ここが緩むと
ポリシー式が正しく見えたまま全世帯が露出します。
本リポジトリのヘルパーは `security definer` ＋ `set search_path = ''` で、参照は全て完全修飾名
（`20260630140000_household_rls_helper.sql`）。この固定が外れていると、関数内の名前解決を
差し替えられる余地が生まれます。

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
