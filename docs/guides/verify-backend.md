# デプロイ済みアプリ・Supabase バックエンドの確認

デプロイされたアプリと Supabase バックエンドが正しく動いているかを確認する手順です。
構成の全体像は [reference/architecture.md](../reference/architecture.md) を参照。

> **テナント分離・ロール境界・Storage ポリシーの正しさは、この手順では確認しません。**
> それは **CI の pgTAP**（[`supabase/tests/`](../../supabase/tests/)）が担保します。
> 理由は下の「§3 なぜ本番で分離を確かめないのか」。

## 1. デプロイ済みフロントエンド（Vercel）

1. [Vercel ダッシュボード](https://vercel.com/dashboard) で mfmf プロジェクトを開く。
2. **Production** の URL（`https://<project>.vercel.app` など）を開く。
3. `/login` でログイン → 一覧 → 新規作成 → 写真添付 → 詳細表示まで動けば正常。
4. ログインできない場合は、Vercel の **Settings > Environment Variables** に
   `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` が
   正しい Supabase プロジェクトの値で設定されているか確認する。

## 2. Supabase バックエンド

[Supabase ダッシュボード](https://supabase.com/dashboard) で対象プロジェクト（`mfmf`）を開く。
**ここで見るのは「動いているか」だけ**です。

| 確認項目 | どこで | 期待状態 |
| --- | --- | --- |
| プロジェクト稼働 | トップ | Status が **ACTIVE / Healthy**。Free は無アクセスで一時停止することがあり、その場合は Restore / Resume。 |
| 認証ユーザー | Authentication > Users | ログインに使うユーザーが存在。**世帯メンバーはそれぞれ自分のアカウント**を持つ（招待で追加。`SIGNUP_ENABLED` が閉じている間は手動発行）。 |
| 世帯とロール | Table Editor | 確認したいユーザーの `household_members` 行と `role`（owner/editor/viewer）が意図どおり。 |
| Storage | Storage | `daycare-photos` バケットがあり **private**。 |
| advisor | Advisors | RLS 未設定や危険な公開設定の警告が **0 件**。DDL 変更後は必ず確認。 |
| migration 履歴 | Database > Migrations | Actions の `migrate` run と突き合わせる（下の ⚠️）。 |

> ⚠️ CI/CD の `migrate` ジョブが `supabase db push` で適用した migration は
> **`supabase_migrations.schema_migrations`** に履歴が残ります（[guides/deploy.md](./deploy.md)）。
> 一方、過去に **SQL Editor で実行した分**や初回 setup で手動適用した分は履歴に残りません。
> ズレを直すときは `supabase migration repair --status applied <version>`。

## 3. なぜ本番で分離を確かめないのか

以前ここには「本番の SQL Editor でポリシー定義を読んで確認する」手順が書かれていましたが、
**削除しました。** レビューで、書かれていた確認方法が 6 回連続で
「**壊れていても無事に見える / 従うとかえって危ない**」ものだと判明したためです。

| 書かれていた確認方法 | 実際どうだったか |
| --- | --- |
| アプリ画面で別世帯のデータを開いてみる | RLS の手前で `householdScopeFilter` が効くので、**壊れていても常に自分の世帯しか出ない** |
| JWT を取って API を直接叩く | 認証に失敗すると `Bearer null` で**空が返り「分離できている」ように見える** |
| `pg_policies` を読み比べる | 出るのは**ヘルパーの呼び出しだけ**。`has_household_role` が `return true` に書き換わっていても全項目が通る |
| `schemaname = 'public'` で絞る | **写真を守っている `storage.objects` が対象外**になる |
| `prosecdef` で絞る | トリガ関数と invoker ヘルパーが出ない |
| 「各テーブルに CRUD 4 種が揃っているか」 | `record_photos` の update などは**意図的に無い**。足すと RPC と招待フローを迂回する経路を自分で開ける |
| 「世帯ヘルパーが現れないポリシーは穴」 | `profiles` / `google_credentials` は `auth.uid() = owner_id` が正解。直すと**世帯メンバーが互いの Google refresh token を読める** |

**分離の正しさは挙動でしか確かめられず、挙動は pgTAP が PR ごとに検証しています。**
手で書いた確認手順は、コードから復元できるものを人間が書き写した時点で腐り始めます
（[decisions.md D16](../explanation/decisions.md)）。分離を疑うときは本番を触らず、
**pgTAP を追加して CI で落とす**のが正しい手順です。

## 4. 接続のスモークテスト

「フロントが正しい Supabase に繋がっているか」を最短で確認する方法。

1. デプロイ済みアプリ（または `npm run dev`）でログインする。
2. 記録を 1 件作成し、写真を 1 枚添付する。
3. Supabase の **Table Editor** で `daycare_records` / `record_photos` に行が増え、
   **Storage** の `daycare-photos` に画像が保存されていれば、フロント ↔ バックエンドの接続は正常。

> RLS により他人のデータは見えないため、判断はブラウザのコンソールではなく
> Supabase ダッシュボード側にデータが反映されるかで行うのが確実。

環境変数の対応表は [reference/configuration.md](../reference/configuration.md) を参照。
