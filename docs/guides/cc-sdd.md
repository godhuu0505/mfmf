# cc-sdd で仕様駆動開発（SDD）を回す

mfmf では、まとまった機能追加を **仕様（spec）を先に固めてから実装する** 進め方に寄せています。
その足回りとして [cc-sdd](https://github.com/gotalab/cc-sdd)（MIT / npm `cc-sdd`）を導入済みです。

cc-sdd は Kiro スタイルの SDD（requirements → design → tasks → implementation）を
**Agent Skills** としてリポジトリに配置するツールです。ランタイム依存は増えません
（`package.json` には何も追加されない）。npx で実行するファイル生成器です。

## 何が入っているか

| パス | 内容 | 編集してよいか |
| --- | --- | --- |
| `.claude/skills/kiro-*/SKILL.md` | 17 個のスキル本体（Claude Code が読む） | ✕ cc-sdd 管理。更新で上書きされる |
| `.kiro/settings/templates/` | requirements / design / tasks / steering の生成テンプレート | ○ プロジェクトに合わせて調整可 |
| `.kiro/steering/` | プロジェクト横断の恒久知識（`product.md` / `tech.md` / `structure.md`） | ○ 生成後に手で育てる |
| `.kiro/specs/<feature>/` | 機能ごとの仕様（`requirements.md` / `design.md` / `tasks.md`） | ○ レビュー対象の成果物 |
| `CLAUDE.md` | ワークフローの説明（「仕様駆動開発」節） | ○ ただし更新時に上書き注意（後述） |

`.kiro/` と `.claude/skills/` は **コミットする**。仕様はレビュー対象の成果物であり、
チーム（＝夫婦＋エージェント）で共有する前提です。

## 使い方

Claude Code のセッションでスラッシュコマンドとして呼びます。

### まず入口

```
/kiro-discovery "写真の一括ダウンロードを付けたい"
```

spec を作るべきか・1 本で足りるか・そもそも不要かを判定し、次に叩くコマンドを提示します。
迷ったら常にここから始めます。

### Phase 0: ステアリング（既存コードベースでは推奨）

```
/kiro-steering                       # product.md / tech.md / structure.md を生成・更新
/kiro-steering-custom "RLS の方針"   # 追加のトピック別ドキュメント
```

`.kiro/steering/` に置かれた内容は以降すべての spec 生成で参照されます。
mfmf では `README.md` / `CLAUDE.md` / `docs/reference/architecture.md` と
食い違わないように保つのがポイントです（重複させるより、参照で寄せる）。

### Phase 1: 仕様

```
/kiro-spec-init "写真の一括ダウンロード"
/kiro-spec-requirements photo-bulk-download
/kiro-validate-gap photo-bulk-download     # 任意: 既存コードとのギャップ確認
/kiro-spec-design photo-bulk-download
/kiro-validate-design photo-bulk-download  # 任意: 設計レビュー
/kiro-spec-tasks photo-bulk-download
```

1 本で通したいときは `/kiro-spec-quick <feature>`、複数 spec に割れたときは
`/kiro-spec-batch`（`/kiro-discovery` が `roadmap.md` を書いた場合）。

### Phase 2: 実装

```
/kiro-impl photo-bulk-download        # 自律モード（タスクごとにサブエージェント＋レビュー）
/kiro-impl photo-bulk-download 2.1    # 指定タスクのみ
/kiro-spec-status photo-bulk-download  # 進捗確認（いつでも）
```

## mfmf での運用ルール

- **各フェーズで人間がレビューする。** `-y` / `--auto` は意図的に早回しするときだけ。
- **spec より CLAUDE.md の規約が優先。** とくに以下は design 段階で弾く:
  - 既存の RLS（`owner_id = auth.uid()`）を弱める設計
  - `service_role` キーをクライアント／リポジトリに持ち込む設計
  - Service Worker で Supabase の API レスポンスや署名付き写真 URL をキャッシュする設計
  - Server Action の `getUser()` 認可チェックを省く設計
- **完了条件は従来どおり** `npm run lint` / `npm run typecheck`（UI・ルーティング・ビルド構成を
  触ったら `npm run build`）。`just check` で一括実行。
- **小さな修正に spec は要らない。** typo 修正や 1 ファイルの軽微な変更は直接実装でよい。
- DB スキーマ変更を含む spec は、tasks に「ローカル `supabase db reset` での確認」を必ず入れる
  （main マージ = 本番適用のため。[deploy.md](./deploy.md#supabasedbマイグレーション) 参照）。

## 更新・再インストール

```bash
npx cc-sdd@latest --lang ja --dry-run --backup   # 差分をプレビュー
npx cc-sdd@latest --lang ja                      # 適用（既存ファイルは対話で選択）
```

> **注意: `CLAUDE.md` は cc-sdd の上書き対象です。**
> cc-sdd は自前のワークフロー説明で `CLAUDE.md` を丸ごと置き換えます。mfmf の `CLAUDE.md` には
> プロジェクト固有の規約（セキュリティ・DB・アーキテクチャ）が入っているため、初回導入時は
> **cc-sdd 版で上書きせず、必要な節だけを手でマージ**しました。更新時も同じ手順を取ってください:
>
> 1. `cp CLAUDE.md /tmp/CLAUDE.md.orig`
> 2. `npx cc-sdd@latest --lang ja`（上書きされる）
> 3. 生成された内容と `/tmp/CLAUDE.md.orig` を見比べ、「仕様駆動開発（cc-sdd / Kiro スタイル）」節
>    だけを更新して残りは元に戻す
>
> 対話プロンプトが使える端末なら、ファイルごとに skip / overwrite を選べます
> （非 TTY では `--overwrite <prompt|skip|force>` で明示指定）。

主なオプション:

| オプション | 用途 |
| --- | --- |
| `--lang ja` | 生成ドキュメントの言語（mfmf は `ja` 固定） |
| `--dry-run` | 適用せず計画のみ表示 |
| `--backup[=<dir>]` | 上書き前にバックアップを取る |
| `--overwrite <prompt\|skip\|force>` | 上書きポリシー（既定は `prompt`、非 TTY では `skip`） |
| `--kiro-dir <path>` | 仕様の置き場所（既定 `.kiro`） |
| `--yes` / `-y` | プロンプトを飛ばす（= `force`） |

## 参考

- リポジトリ: <https://github.com/gotalab/cc-sdd>
- npm: `cc-sdd`（導入時のバージョン: 3.0.2）
