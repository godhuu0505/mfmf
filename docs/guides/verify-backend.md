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
| テナント分離・ロール境界 | **CI（pgTAP）** | 挙動は `supabase/tests/` が PR ごとに検証済み。**本番に対して手で試さない**（理由と内訳は §2-1）。ここで見るのは上下の行（RLS enabled / role / advisor）まで。 |
| Storage | Storage | `daycare-photos` バケットがあり **private**。署名付き URL（期限 1 時間）で配信。 |
| スキーマ適用 | （実体で判断） | 上の実体が揃っていれば適用済み。未適用なら `supabase/migrations/` を SQL Editor で実行。 |
| advisor | Advisors | RLS 未設定や危険な公開設定の警告が **0 件**。DDL 変更後は必ず確認。 |

> ⚠️ **Database > Migrations の履歴**。CI/CD の `migrate` ジョブが `supabase db push` で適用した
> migration は **`supabase_migrations.schema_migrations`** に履歴が残るので、Actions の run と
> 突き合わせて確認できる（[guides/deploy.md](./deploy.md)）。一方、過去に **SQL Editor で実行した分**
> や初回 setup で手動適用した分は履歴に残らないため、移行期は実体（テーブル / ポリシー / バケット）と
> 履歴の両面で判断する。ズレを直したいときは `supabase migration repair --status applied <version>` を使う。

### 2-1. RLS の挙動は pgTAP が担保する（手で確かめようとしない）

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
`RLS tenant isolation (pgTAP)`）。**手元で本番に対して同じことを試す必要はありません。**

**本番で確認するのは「ポリシーが適用されているか」まで**にとどめます。挙動そのものは
pgTAP に任せ、ここでは実体だけを見ます（上の表の「テーブルと RLS」「世帯とロール」「advisor」）。

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
