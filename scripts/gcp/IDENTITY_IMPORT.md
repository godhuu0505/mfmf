# Supabase Auth 原本から Identity Platform へ変換する契約

`identity-import.mjs` は Node 22 の **メモリ内の純粋な変換処理**です。API 呼び出し、
ファイルの読み書き、SDK 初期化、環境変数の読取、ログ出力を行いません。
実取り込み・照合・切替は operator が別途行います。入力と返却された payload は
メール、認証ハッシュ等を含むので、ログ、例外、CI artifact、平文ファイルへ出してはいけません。
ログに利用できるのは `summary` の件数と `IdentityImportError.code` の固定分類だけです。

## 入力と出力

```js
import { convertIdentityImport, toRestBatch } from "./identity-import.mjs";
import { parseSourceArchiveData } from "./source-archive-data.mjs";

// pg_restore の固定 data-only テキスト出力をメモリ内で解釈する。SQL は実行しない。
const { users, identities, mfaFactors } = parseSourceArchiveData(restoreStdoutBuffer);
// targetUsers は移行先の全件 read-only snapshot。
const converted = convertIdentityImport({ users, identities, mfaFactors, targetUsers }, { now: Date.now() });
// converted.batches: Admin importUsers(users, options) に渡せるメモリ上の payload。
// converted.authMirror: DB operator bundle の authMirror に渡す6列の行。
// converted.summary: 件数のみ。バッチは最大1,000件。入力全体の検査は分割前に完了する。
for (const batch of converted.batches) {
  const body = toRestBatch(batch); // 外部への送信・ログ出力は行わない。
  // operator が固定 project の accounts:batchCreate に送信する。
  // 全レスポンスの errors が空であることと実 readback を確認する。
}
```

必要な配列は `users` / `identities` / `mfaFactors` / `targetUsers` の4つです。
最大10,000ユーザー、20,000 identities を受け付けます。入力が空・途中ページ・
欠落テーブルでないことの責任は抽出 operator にあります。converter が API を呼ばないため、
全件性を自己申告 boolean で証明する仕組みはありません。

抽出は `pg_dump --quote-all-identifiers` で作成した暗号化 custom-format 原本を復号し、
固定引数 `pg_restore --data-only --schema=public --schema=auth --no-owner --no-privileges --file=-`
の標準出力を `source-archive-data.mjs` へ渡します。**`--dbname` を指定せず、`psql` へ渡さず、
原本 SQL・関数・trigger を実行しません。** 復号バイトとテキストはメモリ内に限り、
標準出力をユーザー向けログや平文ファイルへ接続しません。
parser は固定 COPY 形式・全必須テーブル/列・UTF-8・escape・行数/バイト上限を検査し、
認証日時を最大6桁の UTC ISO に変換します。認証の JSON 数値は精度が失われるなら拒否します。
凍結後の原本 archive には保全用の `mfmf_cutover` schema も含まれますが、
この抽出では `--schema=public --schema=auth` で対象を限定し、原本 archive 自体は完全なまま保持します。
フィルタを外して任意 schema や SQL を受け入れる変更はしません。

これは import 用のデータ抽出です。別工程の隔離 DB restore-test・全行 readback 比較の
代わりにはならず、両方の成功が切替 gate です。

- `users`: **SQL `auth.users` の行**。`id`, `email`, `aud`, `role`, `is_anonymous`,
  `is_sso_user`, `is_super_admin`, `deleted_at`, `phone`, `phone_confirmed_at`,
  `encrypted_password`, `email_confirmed_at`, `banned_until`, `created_at`, `updated_at`,
  `last_sign_in_at`, `raw_user_meta_data`, `raw_app_meta_data` を原本から抽出します。
  `created_at` / `updated_at` は NULL 不可、日時はタイムゾーン付き RFC3339 に変換します
  （UTC ISO 推奨、PostgreSQL と同じ最大6桁の小数秒）。原本の timestamp 精度は mirror に保持します。
  確認日時・最終ログイン日時・ban なしは、フィールドを落とさず `null` にします。
- `identities`: **SQL `auth.identities` の行**。`id` は identity 行自体の UUID、
  `provider_id` は外部 provider の UID です。Supabase Auth REST の serialized identity は
  `id` / `identity_id` の意味が異なるため、そのまま入力してはいけません。
  `user_id`, `provider`, `provider_id`, `identity_data` が必須です。
  `identity_data.sub` と `provider_id` の一致を検査します。
  Google は `identity_data.email`, boolean `email_verified` も必要です。
- `mfaFactors`: **SQL `auth.mfa_factors` の全行**。空配列が必要です。
  verified / unverified、方式を問わず1行でもあれば移行を停止します。
  「MFA 調査済み」の自己申告や集計値への置換はできません。
- `targetUsers`: **移行先の全 `listUsers` ページ**を結合した Admin UserRecord 形式。
  各行は `uid`, 任意 `email`, 必須 `providerData` 配列（空でも可）。provider は
  `providerId`, `uid`, 任意 `email` を含みます。REST `accounts:batchGet` を使う operator は
  `localId → uid`, `providerUserInfo → providerData`, `rawId → uid` をメモリ内で明示変換します。
  移行先が実際に空の場合だけ `[]` を渡します。既存 UID・メール・Google UID の衝突は拒否し、
  source と衝突しない既存 target アカウントは変更しません。

`authMirror` の各行は `id`, `provider_subject`, `email`, `email_verified`,
`created_at`, `updated_at` の6列です。`id` と `provider_subject` は元の UUID と同一であり、
IdP `uid` とも一致します。未確認メールは mirror では `email:null` とし、
IdP 側の未確認メールと照合状態は保持します。メールは小文字に統一し、大小文字違いの衝突も拒否します。

## 保存する認証情報と明示的な停止条件

- 元 UUID、メール確認状態、作成・更新日時、最終ログイン日時、Google provider UID、
  BCRYPT パスワード、ban / disabled を保ちます。Google + password の linked account は
  両方を一つの UID にまとめたまま取り込みます。Google 行だけでも原本に BCRYPT があれば保ちます。
- BCRYPT は `$2a$` / `$2b$` / `$2y$`、cost 04–31 の完全な60文字を **UTF-8 Buffer** とします。
  salt と rounds は追加しません。暗号化 wrapper、Argon2、その他ハッシュを推測で変換しません。
  Google-only バッチは SDK の hash options が不要です。
- メール確認は `users.email_confirmed_at` のみを正とします。電話確認由来の `confirmed_at` や
  別 linked Google メールから primary email を verified に昇格しません。
  IdP の providerData には provider 単位の emailVerified フィールドがありません。
  その source evidence は暗号化原本に残し、account の emailVerified を保持します。
- 将来の `banned_until`、`infinity`、明示 disabled は disabled として移します。
  期限切れ ban は解除済みとして扱います。**IdP には同じ自動 ban 期限解除がないため、
  futureTimedBans が1以上なら operator が原本を基に解除手順を決めるまで切替を止めます。**
- MFA、匿名、SSO、電話、privileged role、soft-deleted user、email / Google 以外の provider、
  原本から欠けた linked provider、passwordless email identity、未対応ハッシュは拒否します。
  メールリンク認証を passwordless のまま使う経路は今回のアプリにないため、Google と linked でも
  その方式を黙って失う移行はしません。原本を修正して bypass せず、個別設計判断が必要です。
- source 全体で UID・メール・provider UID・identity 行 ID の重複、identity の孤立、
  user と provider の binding 不一致を拒否します。原本にトークン等の追加列があっても
  import payload にコピーしません。旧セッション・refresh token・recovery token は移しません。
  移行後は再ログイン、新規のメール確認・再設定リンクを使います。

## アプリの metadata と利用規約

現アプリの `tos_accepted_at` は signup が書き込む証跡です。RLS やログインの許可判定に
読まれてはいませんが、元にある妥当な日時は同名の custom claim へ保存します。
未設定なら同意を生成しません。任意の `raw_user_meta_data` / `raw_app_meta_data` を
admin 権限等の custom claims に変換しません。

Auth metadata の `display_name` / `full_name` / `name` と `avatar_url` / `picture` は
IdP の表示名・写真 URL に引き継ぎます（URL は検査だけで取得しません）。
既存 `public.profiles` の表示名、default_author、GCS avatar asset 等は元の public DB を
別途完全復元し、同じ owner UUID に紐づけたまま保持します。converter は profiles を作成・更新しません。

## REST 取り込みと復旧の gate

`toRestBatch` はフィールドを再検証し、公式 `projects.accounts:batchCreate` 用に
`uid → localId`, `providerData → providerUserInfo`, `uid → rawId`,
`photoURL → photoUrl`, `metadata → createdAt/lastLoginAt`（epoch ms の文字列）、
`customClaims → customAttributes`（JSON 文字列）、`passwordHash → base64 bytes` に変換します。
常に `sanityCheck:true`, `allowOverwrite:false`, `hashAlgorithm:"BCRYPT"` を付けます。
REST は hashAlgorithm 必須なので OAuth-only にも同じ値を指定し、passwordHash 自体は送りません。

抽出から API 送信の間は source / target のアカウント作成・変更を停止し、
target 全件 preflight に加えて REST の重複検査を使います。API は **部分成功**するため、
HTTP 成功だけで次へ進めません。全 errors が空、UID・verified・disabled・provider UID・
件数等の readback が一致するまで公開しません。失敗時の本文・ユーザー別エラー・payload を
ログに出さず、固定分類と件数だけにします。部分失敗・応答不明は全件を再照合し、盲目的に再送しません。

元の auth schema を含む **age 暗号化原本を長期復旧元として保持**してください。
Firebase は最初の成功ログイン時に内部 scrypt へ再ハッシュします。
それ以前の外部 BCRYPT ハッシュは Firebase export で回収できない場合があり、
移行先 export のみを原本の代替にできません。実パスワード・Google の同一 UID ログイン、
Google managed メール確認 / password reset、disabled 拒否・旧セッション失効を切替 gate に含めます。

## 検証

```bash
node --test tests/scripts/identity-import.test.mjs
npm run lint
npm run typecheck
```

実クラウドには接続せず、合成 SQL 行による正常・拒否・非漏えい契約を検証します。

## 一次資料

- [Firebase Admin user import / BCRYPT / 上限と重複・部分成功](https://firebase.google.com/docs/auth/admin/import-users)
- [UserImportRecord](https://firebase.google.com/docs/reference/admin/node/firebase-admin.auth.userimportrecord)
- [Identity Platform batchCreate / sanityCheck / allowOverwrite](https://docs.cloud.google.com/identity-platform/docs/reference/rest/v1/projects.accounts/batchCreate)
- [REST UserInfo](https://docs.cloud.google.com/identity-platform/docs/reference/rest/v1/UserInfo)
- [REST ProviderUserInfo](https://docs.cloud.google.com/identity-platform/docs/reference/rest/v1/ProviderUserInfo)
- [Supabase Identity の SQL と JSON の field mapping](https://github.com/supabase/auth/blob/master/internal/models/identity.go)
