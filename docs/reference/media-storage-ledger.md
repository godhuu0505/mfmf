# 画像の予約・台帳・切替境界

`20261027073000_media_storage_ledger.sql` は既定の配信元を `supabase` のまま維持する。
GCS バケット・IAM・本番の mode は、この migration では変更しない。

`media_assets.state = ready` と `generation` は、利用者 JWT で実行できる RPC の申告である。
**サーバー検証の証明ではない。** アプリは対象行と世帯権限を確認し、GCS final object の
サーバー専用 metadata・固定 generation・対象 entity/owner/household/reservation の一致を別に確認する。
任意 path を署名する入口を設けない。ブラウザーの PUT は `_incoming/{asset.id}` のみ。

## アプリ用 RPC

| 関数 | 契約 |
| --- | --- |
| `get_media_storage_mode()` | anon/authenticated が書込状態 enum だけ取得 |
| `get_media_read_backend()` | anon/authenticated が現在の読取配信元 enum だけ取得。frozen 中も前値を保持 |
| `reserve_media_upload(kind, entity_id, household_id, byte_size, content_type)` | 個人アバターは本人、世帯アバターは owner、写真・ペットは対象世帯 owner/editor。サーバー生成 ID と固定 path を返す |
| `get_media_upload(asset_id)` | 本人 profile または現在の世帯 member。削除後も同じ範囲で cleanup に必要な台帳を返す。ゲスト権限だけでは取得不可 |
| `commit_media_upload(asset_id, generation, expected_old_path, expected_old_asset_id)` | 予約者と対象の権限を再確認。写真は既存親必須、アバターは旧 path/asset ID の両方を CAS。置換した旧台帳を返す |
| `cancel_media_upload(asset_id)` | 予約者が未公開予約を終端化。公開済みは不可、削除済みへの同じ取消は冪等 |
| `delete_media_reference(kind, entity_id, photo_id, expected_asset_id, expected_old_path)` | 実対象への書込権限と参照 CAS を確認。写真は対象 record と photo ID を両方要求 |

引数名の正式な接頭辞は `p_`。写真の `entity_id` は record ID、他は実対象行 ID。
新しい写真行 ID は asset ID と同じ。`owner_id` は対象の所有者、`created_by` は予約者なので、
editor による他メンバーの記録への追加では異なる。世帯アバターの owner は NULL。

台帳への利用者の直接 INSERT/UPDATE/DELETE は禁止する。参照元 4 テーブルにはトリガーを置き、
直接 REST でも ready 台帳・path・kind・対象 ID・所有者・世帯が一致する場合だけ参照を許す。
最後の参照の削除、親の削除、未完成の予約を残したアカウント削除は deleted にする。
**deleted は operator に対しても終端で、履歴を削除・再公開できない。** 復元は新しい asset/key を使う。

予約は 15 分。1 利用者あたり未期限切れ予約 20 件/100 MiB、世帯あたり ready と未期限切れ予約の合計
1 GiB、1 時間の予約申請 50 件を制限する。期限切れと取消も時間制限に含む。
期限切れ予約は active quota から除外し、operator GC が terminal 化と遅延 object の片付けを行う。
写真 10 MiB、アバター 2 MiB、JPEG/PNG/GIF/WebP/AVIF のみ。移送元がこれを超える場合も自動緩和しない。

## 凍結と operator 移送

`set_media_storage_mode(p_mode)` は end-user claims を持たない superuser/bypass-RLS session の専用関数。
Storage objects・全参照元・親・台帳の table lock を取得し、進行中の DB 書込を待つ。
active backend 同士の直接変更は拒否し、必ず `frozen` を通す。

- `supabase`: 従来の Storage RLS と画像パス参照を維持する。
- `frozen`: 利用者の Storage INSERT/UPDATE/DELETE、参照変更、画像親の削除/移動を拒否する。現在の read_backend を保持して読取を続ける。
- `gcs`: 旧 2 バケットの SELECT も拒否する。アプリから旧 Storage へ fallback しない。

table lock は DB transaction の境界であり、DB 外のアップロード完了や発行済み署名 URL の失効を証明しない。
移送手順は両配信元・古いタブ・直接 Storage API の書込凍結と in-flight drain、前後 snapshot 照合を別に実施する。
既発行の旧署名 URL は最大 1 時間の失効待ちが必要。

operator は `frozen` で移送対象ごとに新しい UUID/key を作り、GCS の全バイト・generation・binding を確認後、
台帳だけを INSERT し、旧参照を保持する。activation の単一 DB transaction で旧 path/asset ID/対象所有者/世帯の参照 CAS 全件と mode/read_backend の gcs 変更を行う。
既存 path が共有されている場合も参照ごとに複製する。利用者 RPC に legacy 登録入口はない。

移送台帳は `is_legacy=true`, `created_by=NULL`, `state=ready` とし、`legacy_sha256`（64 桁小文字 hex）、
`legacy_path`（元 Storage path）、`legacy_reference_id`（写真行 ID、アバターは対象 ID）を必須とする。
この 3 フィールドも immutable。通常予約ではすべて NULL。
mode `gcs` への変更は、独立した全件 hash/readback 検証・復元確認後の別操作にする。

世帯削除は active 台帳・予約・世帯アバターがあれば拒否する。既存の予定/データ存在チェックも保持する。
削除済み台帳は元の世帯 UUID を FK cascade なしで残すため、履歴だけの空世帯は削除できる。
