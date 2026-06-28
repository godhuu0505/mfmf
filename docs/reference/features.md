# 機能一覧

mfmf で現在使える機能を、ユーザー視点でまとめた参照用ドキュメントです。
画面・URL・データモデルの構造は [architecture.md](./architecture.md)、
将来構想・未実装の機能は [../explanation/vision-and-roadmap.md](../explanation/vision-and-roadmap.md) を参照してください。

> 凡例: 🔑 ログイン必須 / 🌐 認証不要 / 📱 PWA 対応

## 認証・アカウント

| 機能 | 概要 | 画面 |
| --- | --- | --- |
| メール + パスワードログイン | Supabase Auth（Cookie セッション）。未ログインは保護画面から `/login` へリダイレクト | `/login` |
| サインアウト | Route Handler で確実にセッション破棄 | `/auth/signout`（POST） |
| 認証コールバック | メール確認・OAuth リターン用 | `/auth/callback` |
| プロフィール編集 🔑 | 表示名 / 記録フォームの「記入者」既定値を保存 | `/settings` |
| パスワード変更 🔑 | 新パスワードを設定 | `/settings` |
| アカウント情報表示 🔑 | ログイン中のメールアドレスを確認 | `/settings` |

## 記録 (daycare_records)

| 機能 | 概要 | 画面 |
| --- | --- | --- |
| 一覧 🔑 | 日付降順、サムネ + 抜粋 + 記録元バッジ + 体重 + タグ + 写真枚数 | `/` |
| 新規作成 🔑 | 日付・本文・記録元・記入者・体重・タグ・写真をまとめて登録 | `/records/new` |
| 詳細 🔑 | 全文 + すべての写真 + メタ情報 | `/records/[id]` |
| 編集 🔑 | クエリ `?edit=1` で詳細画面が編集モードに切り替わる | `/records/[id]?edit=1` |
| 削除 🔑 | Server Action で削除し、Storage 上の関連写真も削除 | `/records/[id]` |
| 記録元バッジ | 🏫 保育園 / 🏠 おうち を視認しやすく色分け | 一覧・詳細 |
| 記入者 | 記録した人を任意で残す | 全画面 |
| 体重(kg) | 任意。記録すると体重グラフへ反映 | 一覧・詳細・`/weight` |
| カレンダー俯瞰 🔑 | 月カレンダーで該当日にバッジ表示。`?ym=YYYY-MM` で月送り | `/calendar` |

## 検索・絞り込み・並び替え

| 機能 | 概要 | 仕様 |
| --- | --- | --- |
| キーワード検索 | 本文 + 記入者を `pg_trgm` で部分一致検索 | `?q=` |
| 期間絞り込み | 開始日 / 終了日で範囲指定 | `?from=&to=` |
| 記録元絞り込み | 全て / 保育園 / おうち | `?source=` |
| タグ絞り込み | 一覧上部のタグチップから 1 タグで絞り込み | `?tag=<id>` |
| 並び替え | 日付 ↓↑ / 体重 ↓↑ の 4 軸 | `?sort=` |
| ページネーション | サーバ側でページング | `?page=` |
| URL クエリ同期 | 上記すべてが URL に反映され、共有・リロード・戻る/進むで状態を再現できる | `/?q=&from=&to=&source=&tag=&sort=&page=` |

## 写真

| 機能 | 概要 |
| --- | --- |
| 複数枚アップロード 🔑 | 1 記録に対して複数の写真を紐付け |
| クライアント直接アップロード | ブラウザから Supabase Storage へ直接 PUT（Vercel Function ボディ上限 4.5MB を回避） |
| 自動リサイズ・再圧縮 | 送信前に長辺 1600px / JPEG へ変換（`src/lib/imageResize.ts`） |
| 署名付き URL | 表示時に Storage の signed URL（1 時間）を発行（プライベートバケット） |
| ストレージ命名規約 | `{owner_id}/{record_id}/{filename}`（`src/lib/storagePath.ts` で生成・検証） |
| 一覧サムネイル | 各記録の先頭写真を 80px サムネで表示 |
| 写真ギャラリー 🔑 | 全記録の写真を新しい順に最大 300 枚、ライトボックスで拡大 |

## タグ (tags)

| 機能 | 概要 |
| --- | --- |
| 自由タグ付け 🔑 | オーナーごとの辞書から既存タグを選択、または新規追加（フォーム上で補完） |
| タグ一覧表示 | 記録カード上にタグを表示 |
| タグで絞り込み | 一覧上部のタグチップから 1 クリック切替 |
| 名前正規化 | 前後空白を除去、最大 50 文字（DB 制約と一致） |

## ペット (pets)

| 機能 | 概要 | 画面 |
| --- | --- | --- |
| 一覧・追加・編集・削除 🔑 | 多頭飼いに備えた CRUD | `/pets` |
| 属性 | 名前（必須）/ 種類（任意：犬・猫など）/ 誕生日（任意） | `/pets` |

## 体重トラッキング

| 機能 | 概要 | 画面 |
| --- | --- | --- |
| 推移グラフ 🔑 | 体重が記録された全日を時系列でプロット（SVG） | `/weight` |
| 直近値・最古値・差分表示 | 期間の増減を一目で確認 | `/weight` |

## 共有リンク (share_links)

| 機能 | 概要 | 画面 |
| --- | --- | --- |
| 作成 🔑 | ラベル・期間（任意）・有効期限（任意）を指定してトークンを発行 | `/shares` |
| 失効・削除 🔑 | いつでも無効化・完全削除 | `/shares` |
| URL コピー 🔑 | 共有 URL をワンクリックでクリップボードへ | `/shares` |
| 公開ビュー 🌐 | トークン経由で記録テキストを閲覧専用表示（**写真は含めない**） | `/share/[token]` |
| トークン検証 | `SECURITY DEFINER` の `get_shared_view` 関数でサーバ側検証 | DB |
| SEO 非インデックス | `robots: noindex, nofollow` | `/share/[token]` |

## フィードバック

| 機能 | 概要 |
| --- | --- |
| フィードバックウィジェット 🔑 | どの画面からでも開けるフロート式ボタン（`FeedbackWidget`） |
| 種別選択 | バグ / 要望 / 質問 |
| 困り度・頻度 | 任意（blocker / annoying / minor / idea, always / sometimes / once / unknown） |
| 詳細フィールド | タイトル・本文・発生日時・期待動作・実際の動作・報告者名（任意） |
| 端末コンテキスト自動収集 | URL・User Agent・言語・ビューポート・画面サイズ・DPR・オンライン状態・PWA 起動有無・タイムゾーン・送信時刻 |
| 保存先 | Supabase の `feedback` テーブルのみ（GitHub には送信しない） |
| Issue 化運用 | 別プロセスで非公開リポへ Issue 化（[guides/feedback-to-issues.md](../guides/feedback-to-issues.md)） |

## PWA 📱

| 機能 | 概要 |
| --- | --- |
| Web App Manifest | ホーム画面追加・スタンドアロン表示・テーマカラー（`src/app/manifest.ts`） |
| アプリアイコン | `npm run icons` で生成 |
| Service Worker | 静的アセットのキャッシュ（`public/sw.js`） |
| オフラインフォールバック | ネットワーク不通時に表示する画面（`/offline`） |
| キャッシュ除外（不変条件） | Supabase API レスポンス・署名付き写真 URL はキャッシュしない |

## Google Drive 連携（基盤のみ）

| 機能 | 概要 |
| --- | --- |
| OAuth リフレッシュトークン保管 | アプリ層で暗号化（`src/lib/google/crypto.ts`）して `google_credentials` テーブルに保存 |
| 設定ガイド | [guides/google-drive-setup.md](../guides/google-drive-setup.md) |

> Drive へのバックアップ機能本体は今後の拡張。現状はトークン管理の基盤のみ。

## セキュリティ・データ保護

| 機能 | 概要 |
| --- | --- |
| RLS 強制 | すべてのテーブルで `owner_id = auth.uid()` ベースのポリシー |
| Server Action 認可 | 各 Server Action 冒頭で `supabase.auth.getUser()` を確認 |
| middleware セッション更新 | `src/middleware.ts` で全リクエストのセッションを更新 |
| Storage バケット非公開 | プライベートバケット + 都度の signed URL |
| 入力サニタイズ | ファイル名等を `buildStoragePath` で検証 |
| シークレット保護 | `.env.local` 等の実 env ファイルへのアクセスを Claude 側でガード |

## 運用・CI

| 機能 | 概要 |
| --- | --- |
| CI ゲート | lint → typecheck → build（`.github/workflows/ci.yml`） |
| ローカル一括チェック | `just check`（CI と同じ） |
| Docker でアプリ起動 | `just up` / `just down`（Node.js 22 で CI と同条件） |
| Vercel デプロイ | main→Preview, Release タグ→Production（[guides/deploy.md](../guides/deploy.md)） |
