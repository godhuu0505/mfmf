# 画像manifestのオフライン照合

[GCP移行前の棚卸し](./gcp-migration-preflight.md)のP2準備として、コピー元・コピー先・DB参照・削除履歴の
**入力metadataだけ**を比較する。このCLI自身は本番データの取得や移行を行わない。
取得・暗号化保全は別の[運用専用Storageバックアップ](./storage-operator-backup.md)を参照する。

```bash
node scripts/gcp/reconcile-storage-manifest.mjs < tests/fixtures/gcp/storage-manifest.synthetic.json
node --test tests/scripts/storage-reconciliation.test.mjs
```

Node 22の組込機能だけを使う。CLIは標準入力以外のファイルを読まず、env読取・ネットワーク・SDK・
copy / sync / delete・署名発行・コマンド実行を持たない。引数でファイル名やURLを指定することもできない。
UTF-8 JSONを最大1MiB・合計5,000エントリ・入力10秒まで受け付ける。超過、不正JSON、不正schema、
stream障害では値や例外本文を出さず終了する。CIは既存の `tests/scripts/*.test.mjs` ゲートで架空fixtureを検証する。

## 入力の契約

[例](../../tests/fixtures/gcp/storage-manifest.synthetic.json)のpath・size・hashはすべて架空。
オブジェクトの本体はなく、hashが本体と一致することを検証した例ではない。

| フィールド | 契約 |
| --- | --- |
| `formatVersion` | `1` |
| `source` / `destination` | 現行オブジェクトの配列。各要素は `bucket`, `path`, `size`, `hashes` の4項目 |
| `bucket` | 論理bucket `daycare-photos` または `avatars`。実GCS bucket名・URL・資格情報は含めない |
| `path` | 空でない、最大1,024 UTF-8 byteの名前。制御文字は禁止。大小文字・空白・URL escape・Unicode・旧ownerパスを変換せず、bucketと名前の完全一致で比較 |
| `size` | byte単位の非負safe integer、または未取得を表す `null` |
| `hashes` | 明示的なchecksum。`sha256`＝64桁、`md5`＝32桁、`crc32c`＝8桁のhex文字列。未取得は `{}`。hexの大小文字は同値扱い |
| `references` | `record_photos`, `profiles`, `households`, `pets` の4配列をすべて含める |
| `tombstones` | `{ bucket, path }` の配列。削除済みとして扱うべき名前の入力履歴。削除命令ではない |

参照元は `record_photos.storage_path` → `daycare-photos`、
`profiles.avatar_path` / `households.avatar_path` / `pets.avatar_path` → `avatars`。
avatarの `null` は未設定として数えるが、写真の `null` や空文字は不正入力。
Googleの外部avatar URLは対象外。同じ画像を複数行が参照することは許す。
各inventoryとtombstone内の重複objectは曖昧なため拒否し、未知フィールドも黙って無視しない。

ETagはchecksumではないため、このschemaへそのまま渡さない。共通algorithmの明示checksumだけを比較し、
サイズだけ・checksumなし・異なるalgorithm同士では一致にしない。複数の共通checksumはすべて比較し、
ひとつでも違えば不一致。CRC32C/MD5による比較を悪意ある改変への暗号学的な保証として使わない。
将来provider metadataを取り込む場合のエンコーディング変換・checksum取得は、別のレビュー対象とする。

## 出力と終了コード

出力は固定の分類語・集計と、元入力を参照する**0始まりの配列index**のみ。
`at: { collection: "source", index: 0 }` は `source[0]`、`related` は対応する別配列の位置。
`references` の位置には固定のtable名も付く。path・row ID・size値・hash・URL・原入力・例外本文は出さない。
集計と配列位置にもmetadataはあるため、実manifestや照合結果を公開ログ/PRへ載せる運用は別途判断する。

| 分類 | 意味 |
| --- | --- |
| `referenced-source-missing` / `referenced-destination-missing` | DB参照に対応するobjectが各入力inventoryに無い |
| `destination-missing` / `destination-only` | sourceのobjectがdestinationに無い／destinationだけにある |
| `source-unreferenced` / `destination-unreferenced` | 入力した4参照元から参照されていない。実際の孤児・削除可能とは断定しない |
| `size-mismatch` / `hash-mismatch` | 同じbucket/pathのsize、または共通checksumが異なる |
| `comparison-inconclusive` | `missing-size` または `no-common-hash` で比較不能 |
| `tombstone-reference` | 削除履歴の名前をDBが参照している |
| `tombstone-source-present` / `tombstone-destination-present` | 削除履歴の名前が各inventoryに残っている |
| `tombstone-absent` | 入力上、両inventory・参照から消えている。履歴の破棄や遅延PUT不存在の証明にはならない |

分類は重複し得る。tombstoneのあるobjectは通常のペア比較に含めない。名前の再使用や復元が正当かは
入力だけでは判定できず、tombstoneとの衝突として人が確認する。timestampで自動解決しない。

- **0:** `comparison: matched`。非空のmetadataペアが一致し、未参照・欠落・矛盾・比較不能がない。
- **2:** `differences` / `inconclusive` / `empty`。比較不能だけなら `inconclusive`、不一致もあれば `differences`。
  空入力・tombstoneだけの入力も成功にしない。
- **1:** 引数・入力・出力のエラー。診断は固定文のみ。

**どの場合も `readiness: not-assessed`。終了0も移行合格ではない。** 入力が完全で同時点のsnapshotか、
checksumが本体由来か、コピー後に内容が変わっていないかをこのCLIは確認しない。世代管理・soft deleteの
旧版、IAM/RLS、署名URL、実画像の表示、復元、削除競合・逆同期も対象外。
大量データを分割投入した場合の全体重複・横断参照も保証しない。実移行用の取得・保管・整合snapshot・
全件突合の手順を定めるまで、結果をcopy/delete判断や本番切替に使わない。
