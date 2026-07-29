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
| テナント分離 | （下の §2-1 で確認） | 別世帯のユーザーの JWT で **API を直接叩いて**他世帯の行が返らないこと。**アプリ画面で見て確認しない**（理由は §2-1）。自動での担保は CI の pgTAP `supabase/tests/`。 |
| Storage | Storage | `daycare-photos` バケットがあり **private**。署名付き URL（期限 1 時間）で配信。 |
| スキーマ適用 | （実体で判断） | 上の実体が揃っていれば適用済み。未適用なら `supabase/migrations/` を SQL Editor で実行。 |
| advisor | Advisors | RLS 未設定や危険な公開設定の警告が **0 件**。DDL 変更後は必ず確認。 |

> ⚠️ **Database > Migrations の履歴**。CI/CD の `migrate` ジョブが `supabase db push` で適用した
> migration は **`supabase_migrations.schema_migrations`** に履歴が残るので、Actions の run と
> 突き合わせて確認できる（[guides/deploy.md](./deploy.md)）。一方、過去に **SQL Editor で実行した分**
> や初回 setup で手動適用した分は履歴に残らないため、移行期は実体（テーブル / ポリシー / バケット）と
> 履歴の両面で判断する。ズレを直したいときは `supabase migration repair --status applied <version>` を使う。

### 2-1. テナント分離は「アプリ画面で見て」確認してはいけない

**アプリを別世帯のユーザーで開いても、RLS が壊れているかどうかは分かりません。**
`src/app/page.tsx` は RLS の手前で `householdScopeFilter(householdId)` を掛けており
（`src/lib/household.ts`）、**アプリ側が現在世帯で先に絞り込んでいます**。
そのため、仮に本番のポリシーが全世帯を許してしまっていても、画面には自分の世帯の行しか
出ません。**画面が正しく見えることは、API が守られていることの証拠になりません。**

アプリの絞り込みを通らない経路で確かめます。

```bash
# 1) 確認したいユーザーでログインしてアクセストークン（JWT）を得る
curl -s "$NEXT_PUBLIC_SUPABASE_URL/auth/v1/token?grant_type=password" \
  -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"<確認用ユーザー>","password":"<パスワード>"}' | jq -r .access_token
# → 出力を $JWT に入れる（この値はセッションそのもの。共有・コミットしないこと）

# 2) 絞り込みを一切掛けずに全件取りに行く
curl -s "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/daycare_records?select=id,household_id" \
  -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $JWT" | jq -r '.[].household_id' | sort -u

# 3) 別世帯の既知の行を id 指定で狙い撃ちする（返らないこと ＝ 空配列）
curl -s "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/daycare_records?id=eq.<別世帯の記録 id>" \
  -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $JWT"
```

**期待**: 2) は自分が所属する世帯の `household_id` だけ（複数世帯に属するならその集合だけ）。
3) は `[]`。どちらかで他世帯の行が返れば **RLS が破れています**。

> `$NEXT_PUBLIC_*` はブラウザに公開される前提の値なので curl に置いても構いませんが、
> **JWT はセッションそのもの**です。ログや issue に貼らないこと。
>
> 恒久的な担保は CI の pgTAP（`supabase/tests/`）です。上の手順は
> 「本番の実体が pgTAP と同じ状態か」を目視で 1 回確かめるためのもので、
> DDL やポリシーを変えた直後にだけ実施すれば十分です。

## 3. 接続のスモークテスト

「フロントが正しい Supabase に繋がっているか」を最短で確認する方法。

1. デプロイ済みアプリ（または `npm run dev`）でログインする。
2. 記録を 1 件作成し、写真を 1 枚添付する。
3. Supabase の **Table Editor** で `daycare_records` / `record_photos` に行が増え、
   **Storage** の `daycare-photos` に画像が保存されていれば、フロント ↔ バックエンドの接続は正常。

> RLS により他人のデータは見えないため、判断はブラウザのコンソールではなく
> Supabase ダッシュボード側にデータが反映されるかで行うのが確実。

環境変数の対応表は [reference/configuration.md](../reference/configuration.md) を参照。
