# 設計上の判断（なぜこうなっているか）

mfmf がいまの構成を選んでいる理由をまとめます。「何が」あるかは
[reference/architecture.md](../reference/architecture.md)、手順は各 [guides/](../guides/) を参照。

## ¥0 構成（Vercel + Supabase）

夫婦 2 人で使うミニマムな PWA であり、運用コストをかけない方針。フロント配信を Vercel Hobby、
認証 / DB / 画像を Supabase Free に寄せることで、無料枠の範囲で完結させている。
ネイティブアプリ化や独自サーバーは持たない。

## 共有方針: (A) 1 アカウント共用

夫婦で同じログインを共用する前提。`household_id` のような世帯概念は持たず、
`owner_id (= auth.uid())` ベースで RLS を設定している。

- **理由**: 2 人で同じ記録を見たいだけなので、世帯テーブルや招待フローを作るより、
  1 アカウントを共有するほうが圧倒的に単純。
- **帰結**: ユーザーを分けると RLS により記録が互いに見えなくなる。ユーザーは
  **共有する 1 つ**だけ発行する。
- **将来 (B) 世帯共有へ移行する場合**は `household_id` 列を追加して移行する想定。

## フェーズ1 のスコープ

記録（テキスト + 写真）を残して夫婦で振り返る、という核だけを作る。

- ① ログイン（email/password、サインアップ UI 無し）
- ② テキストの保管・表示（記録の CRUD）
- ③ 画像の紐付け（複数枚アップロード → Storage → 表示・サムネ）
- ④ 記録メタデータ（記録元 🏫保育園 / 🏠おうち・記入者・体重）
- ⑤ ご意見・不具合フォーム

**意図的に外すもの**: LINE 自動取り込み / カレンダー連携 / Google ドライブ・フォト連携 /
プッシュ通知 / ネイティブアプリ。やりたいことを増やしすぎず、まず日々続けられる最小形を優先する。

## PWA・画像処理（フェーズ1.5）

- **PWA 化**: `manifest`（Next.js metadata route）+ Service Worker（`public/sw.js`）でホーム画面に
  追加でき、スタンドアロン表示・オフラインフォールバック（`/offline`）に対応。SW は本番ビルドのみ登録。
  静的アセットは stale-while-revalidate、ページ遷移は network-first。
- **画像のアップロード時リサイズ・圧縮**: ブラウザ側で長辺 1600px へ縮小・JPEG 再圧縮
  （`src/lib/imageResize.ts`）。EXIF の向きも反映。Storage 使用量と通信量を抑えるため。
- アイコンは外部ライブラリに依存せず Node 標準の zlib で PNG を直接エンコードして生成（`npm run icons`）。

## セキュリティ

- **一次防衛線は Supabase の RLS**（`owner_id = auth.uid()`）。Server Action でも冒頭で
  `getUser()` による認可チェックを省略しない。
- `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` はブラウザ公開前提の値。
  RLS で守っているため公開してよい。一方 **`service_role` キーは絶対に使わない・置かない**。
- **Service Worker は Supabase の API レスポンスや署名付き写真 URL（private・期限付き）をキャッシュしない**。
  期限切れ URL や他人に見えてはいけない内容がキャッシュに残らないようにするための不変条件。
- 入力由来の値（ファイル名等）はサニタイズする（`buildStoragePath`）。

### フィードバックを GitHub に送らない理由

ご意見・不具合フォームには個人的な内容が入りうる。公開リポジトリに漏れることを防ぐため、
アプリは **GitHub に何も送らず**、内容は Supabase の `feedback` テーブル（非公開・RLS 保護）にのみ保存する。
Issue 化が必要なときだけ、個人情報をマスクして **非公開リポジトリ宛て**に手元のスクリプトで転記する
（[guides/feedback-to-issues.md](../guides/feedback-to-issues.md)）。

## デプロイ方針

デプロイは **GitHub Actions から Vercel CLI で明示的に**行い、Vercel の Git 連携自動デプロイは
無効化している（`vercel.json` の `git.deploymentEnabled: false`）。

- **理由**: 「いつ・どこへ出すか」を Actions に一本化し、Vercel の Git 連携による意図しない
  自動デプロイを防ぐ。
- **main へのマージ = 本番リリース**。`deploy-production.yml` が `migrate` → Vercel Production deploy の
  順で走る（merge = release）。本番への誤発射を防ぎたい場合は GitHub Environment `production` に
  Required reviewers を付けて承認ゲートにできる。
- **DB マイグレーションも CI/CD で自動適用**する（`supabase db push`）。Vercel deploy より前に
  `migrate` ジョブを走らせ、本番 DB とコードのスキーマ整合性を保つ。
- Supabase は **単一の本番プロジェクト**を使う（Free 枠の active 2 プロジェクト上限のため、別建ての
  preview 用 DB は本番運用と両立できない）。Database Branching は Pro プラン以上の機能で、現スコープでは
  採用しない。
- Free プランには自動バックアップも PITR も無いため、`migrate` ジョブは `supabase db push` の**前に**
  本番 DB をダンプして GitHub Actions Artifact に 90 日保存する。これが**唯一のロールバック資産**。
- destructive な SQL（DROP / RENAME / SET NOT NULL / TRUNCATE / DELETE）は PR の CI で warning を
  出すが強制ブロックはしない。やむを得ない destructive 変更があり得るため、判断は PR レビューに委ねる。
- Storage バケット（`record_photos` の画像）は DB バックアップに含まれず Free プランでも復旧手段が
  無い。**写真の事故からは戻せない**ことを許容する設計。

手順は [guides/deploy.md](../guides/deploy.md) を参照。
