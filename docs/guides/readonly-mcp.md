# Claude・ChatGPTからmfmfを読む

接続先はアプリの公開URLに `/mcp` を付けます。`MCP_ENABLED=true` と本番GCP認証が揃う環境だけで利用できます。
Googleログインやメール/パスワードで本人確認した後、接続するAIと1つの家族を確認して許可します。
接続後にアプリの表示中の家族を切り替えても、AIの対象家族は変わりません。別の家族には別の同意が必要です。

AIが読めるのは、選んだ家族のペット名・種類と、記録ずみの本文・日付・種類・体重です。
本文は家族内で共有される情報です。`guest_visible=false` はゲストへの非表示であり、本人だけの秘密メモではありません。
メール・URL・本文中のUUIDを限定的に伏せますが、完全な匿名化は保証しません。本文は接続先AIへ渡ります。
解除しても、既にAIの会話へ渡った情報は消えません。写真・写真URL・記入者・メンバー一覧・メール・認証情報は返しません。

## 読み取りの境界

- `list_pets`、`search_records`、`get_record` の3つだけ。追加・更新・削除・招待・ランキング検索・外部URL取得はありません。
- 正規メンバー owner/editor/viewerのみ。guestと不明なroleは拒否します。全クエリは既存Cloud SQL RLSと固定household_id条件の両方を使います。
- 記録検索は通常の文字検索。1回20件、検索文100文字、期間62日以内（未指定は直近31日）。詳細本文は2000文字までです。
- レスポンスのIDは認可済みペット/記録のUUIDだけ。IdP subject、内部ユーザーUUID、household/member IDを返しません。
- 本文は利用者の入力です。命令として信頼したり、記載されたリンクを自動的に訪問したりしません。
- 公式SDKのstateless Streamable HTTPを各HTTP要求で新しく生成します。SSE、永続セッション、ユーザー間キャッシュはありません。

## OAuthと保存先

scopeは `mfmf.read`、issuerは既存 `GCP_AUTH_ORIGIN`、resourceはその `/mcp` と完全一致します。
wkwk/mnmnの鍵・クライアント・grantを受け付けません。通常のCookieやFirebase ID tokenだけではMCPを呼べません。
S256 PKCE必須、コード120秒・1回限り、access key10分、refreshは使い捨て、接続は最大30日で延長しません。
コード/refreshの再利用は接続全体を失効させます。既存IdPのdisabled・email verified・tokensValidAfterTime、
subjectと内部UUIDの対応、現在の世帯roleをtoken交換・refresh・HTTP要求ごとに再検査します。
MCPからアカウントを作成することはありません。アプリが登録受付中でも `allowCreate:false` を強制します。

OAuth情報は `mfmf-499612` のFirestore named database `mfmf-mcp` に保存します。業務記録は複製しません。
生のcode/access/refresh/client secret/同意ハンドルは保存せずSHA-256だけを保存します。
ADCを使い、ブラウザのFirestoreアクセスは全拒否します。既存Cloud SQLのロール・RLS・スキーマは変更しません。
SDKをmockしない実OAuthライブラリ試験と、架空データだけの実Firestore emulator試験をCIで行います。

登録100/日、認可開始500/日、tokenはclientごと120/分、MCPはgrantごと120/分です。
新規接続は利用者ごと固定30日枠で20件まで。接続一覧は生存中の接続を先に絞り込みます。
DBのTTL削除を期限・認可判定の代わりにはしません。全応答no-store。本文、OAuth資格情報、上流例外はログに出しません。

## 本番準備・無効化

1. 通常PR/CI/レビューと、同じmain SHAの配信を確認します。
2. 専用projectでFirestore APIを有効化し、Tokyoのnamed database `mfmf-mcp` を作ります。
3. `infra/mcp/firestore.rules` をそのDBへ適用し、`infra/mcp/firestore.indexes.json` の索引READYを確認します。
4. runtime SAのFirestore権限はnamed DBへの正確なresource.name条件に限定します。既存の画像・DB・認証権限を広げません。
5. 既存設定を保ったままserver-onlyの `MCP_ENABLED=true` だけを追加します。通常配信はこの値を検証して維持し、public/build envへ入れません。
6. 匿名401 challenge、discovery、偽key/Cookieだけの拒否を確認後、本人の同意を経て実クライアントでtools/listと読み取り・解除後の拒否を確認します。

`MCP_ENABLED=false` で新規接続と既存keyによる呼び出しを止められます。通常のmfmf記録表示・保存は続けられます。
Cloud設定の適用は運用担当が行い、テストや開発スクリプトから実リソースを自動作成しません。
