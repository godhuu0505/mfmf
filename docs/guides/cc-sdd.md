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

## 既知の注意点（upstream 由来）

`.claude/skills/kiro-*/` は cc-sdd が生成する vendored ファイルで、**手で書き換えても次の
`npx cc-sdd@latest` で消えます**。そのため以下は修正せず、運用でカバーします
（気になるものは [upstream](https://github.com/gotalab/cc-sdd/issues) に issue を立てる）。

### `-y` は「早回し」ではなく「承認」の意味になる

cc-sdd には**承認だけを行うコマンドがありません**。`/kiro-spec-requirements` は
`spec.json` に `approvals.requirements.generated: true` を書くだけで `approved` は立てず、
次の `/kiro-spec-design` は `approved: false` だと停止します。停止時に案内される回避策は
`/kiro-spec-design <feature> -y` のみで、これが requirements を自動承認します
（design → tasks 間も同じ構造）。

これは design → tasks 間も同じで、`kiro-spec-tasks` の `allowed-tools`
（`Read, Write, Edit, Glob, Grep, Agent`）にも `AskUserQuestion` が無いため、
生成した計画の承認を対話で取ることができません。**`-y` 以外に前進する手段がない**構造です。

**運用**: `-y` は「人間が読んで承認済み」の意思表示として使う。付ける前に必ず
`.kiro/specs/<feature>/requirements.md`（design なら `design.md`、tasks なら `tasks.md`）に
目を通すこと。読まずに `-y` を付けるのは、このリポジトリのルール違反です。

### `/kiro-spec-quick` の対話モードは tasks を無レビューで通す

`--auto` なしでも、tasks 生成の内部呼び出しに `-y` が渡ります。生成後の人間向け確認が
入らないため、`tasks.md` がレビューされないまま `/kiro-impl` に渡り得ます。

さらに `/kiro-spec-quick` の `allowed-tools` は `Read, Skill, Bash, Write, Glob, Agent` で
`AskUserQuestion` を含まないため、対話モードが必要とする yes/no 確認をそもそも取得できません。
**「対話モード」は実質機能しない**と考えてください。

**運用**: `/kiro-spec-quick` を使ったら、`/kiro-impl` の前に必ず `requirements.md` /
`design.md` / `tasks.md` を自分で読む。レビューを確実に挟みたいなら
`/kiro-spec-init` からの分割実行を使う（こちらを推奨）。

### タスクは必ず `X.Y` の子タスクに割る

`tasks.md` のテンプレートは「Major task only」（`- [ ] 1. ...` 単体）の形も許容しますが、
`/kiro-impl` の実行キューは `X.Y` 形式だけを実行単位とみなし、`X.` はグルーピング見出しとして
読み飛ばします。単体の major task だけの計画は、自律モードで**何も実装されないまま完了扱い**に
なり得ます。

**運用**: `/kiro-spec-tasks` の出力に単体 major task があれば、`1.1` などの子タスクに割り直す。

逆に、テンプレートが「後回しにできるテスト」用に定める **optional マーカー `- [ ]* X.Y`**
（`tasks.md` テンプレート 24 行目）は、`/kiro-impl` のキューでは通常の実行対象として拾われます。
MVP 後に回すつもりのタスクまで自律モードが実装し、その失敗が feature 全体を止め得ます。

**運用**: optional タスクを含む計画で `/kiro-impl` を回すときは、**タスク番号を明示指定**して
必要なものだけ実行する。

### `/kiro-impl` は作業ツリーをクリーンにしてから走らせる

`/kiro-impl` は開始時に `git status --porcelain` を「記録する」だけで、クリーンであることを
要求しません。ステージ済みの無関係な変更があると、最初のタスクコミットに巻き込まれます
（タスクコミットは `--only` パススペックを使わないため）。また、あるタスクが `BLOCK_TASK` で
失敗した場合、その部分実装を revert せずに次のタスクへ進むため、以降のレビュー用 `git diff` が
汚染され、未完成コードがコミットに残り得ます。

**運用**: `/kiro-impl` の前に `git status` がクリーンであることを確認する。実行後も
`git status` と `git log` で、意図しない変更が混ざっていないか必ず確認する。
`_Blocked:_` が付いたタスクが出たら、そこで一度止めて手で作業ツリーを片付ける。

### スキル内蔵の秘密情報スキャンは当てにしない

reviewer / feature validation の秘密情報スキャンは、説明文に「case-insensitive」とありながら
実際のコマンドに `-i` が付いていません（`reviewer-prompt.md:44`、`kiro-validate-impl/SKILL.md:98`）。
`PASSWORD =` や `API_KEY =` のような大文字表記を取りこぼします。

しかも `grep -rn` はマッチした**行全体を出力に出す**ため、万一本物の credential が引っかかった
場合、その値をレビュー出力（＝会話ログ）に晒します。**取りこぼす一方で、当たったときは漏らす**
という二重の問題があります。

**運用**: このリポジトリの秘密情報に対する防衛線は、従来どおり
**`.claude/hooks/guard.mjs`・`.gitignore`・人間のレビュー**。cc-sdd のスキャン結果が
クリーンでも、それを根拠にしない（「セキュリティ（厳守）」は `CLAUDE.md` が正）。
スキャンが何かを検出したら、**その出力を貼り回さず**、まず値そのものを潰すこと。

### このリポジトリでは `MANUAL_VERIFY_REQUIRED` が正常な結果

`/kiro-validate-impl` は「ビルド成果物が実際に起動することを示す canonical な smoke コマンド」を
要求し、見つからなければ `MANUAL_VERIFY_REQUIRED` を返します。mfmf には smoke / health check /
ブラウザテストのコマンドが無く（`package.json` / `justfile` / `ci.yml` のいずれにも無い）、
アプリの実起動には Supabase のセットアップが要るため、**`just check` が通っていても
`MANUAL_VERIFY_REQUIRED` で止まります**。

**運用**: これは失敗ではなく想定どおり。`just check`（lint / typecheck / build）が通っていれば、
あとは `just dev` で該当画面を手で触って確認し、先に進んでよい。

### `/kiro-discovery` が「既存 spec の拡張」と判定したら自分で書き写す

Path A（既存 spec の守備範囲内）と判定された場合、discovery はそこで打ち切り、
**判定内容をどこにも書き出しません**。後で `/kiro-spec-requirements <feature>` を実行しても
渡るのは feature 名と古い spec だけなので、拡張したかった内容が反映されずに再生成され得ます。

加えて Path A の判定は、既存 spec の `spec.json`（メタデータのみ）を見た段階で下されます。
`requirements.md` を読むのは Step 3 で、Path A はそこに到達しません。つまり
**名前が似ているだけの spec が、実際には守備範囲外の作業の受け皿に選ばれ得ます**。

**運用**: Path A と言われたら、まず**その spec の `requirements.md` を自分で読んで
本当に守備範囲内か確かめる**。そのうえで、要望をその場で `requirements.md` に追記するか、
少なくともメモに残してから次のコマンドに渡す。セッションを跨ぐと失われる。

### `/kiro-impl` は最終検証を自分で呼べない

`kiro-impl` の `allowed-tools` に `Skill` が無いため、自律モードの Step 4 が要求する
`/kiro-validate-impl {feature}` を呼び出せません（`kiro-spec-quick` は `Skill` を持つ）。
GO / NO-GO ゲートが黙ってスキップされる可能性があります。

**運用**: `/kiro-impl` が終わったら、**自分で `/kiro-validate-impl <feature>` を叩く**。
ただし前述のとおり、このリポジトリでは結果が `MANUAL_VERIFY_REQUIRED` になる。

### `/kiro-steering` の結果はファイルの差分で確認する

Sync フロー（コア 3 ファイルが揃っている場合）は「更新を提案する」→「報告する」で終わっており、
**受け入れた更新を書き戻す手順が明示されていません**。`.kiro/steering/*.md` が古いままでも
「Steering Updated」と報告され得ます。また `/kiro-steering-custom` は `allowed-tools` に
`AskUserQuestion` が無いため、トピックや文書化したい内容を対話で聞き出せません。

さらに `/kiro-steering-custom` を**同じトピックで再実行すると、既存の
`.kiro/steering/{name}.md` を読まずにテンプレートから生成して上書きします**。
手で書き足した内容が消えます。

**運用**: `/kiro-steering` の実行後は `git diff .kiro/steering/` で実際に反映されたか必ず確認する。
`/kiro-steering-custom` は**トピックと書きたい内容を最初の引数で渡しきる**。
既存の custom steering を育てたいときは、コマンドを再実行せず**直接エディタで編集する**。

### 上流を作り直したら下流も必ず作り直す

承認済み spec に対して `/kiro-spec-requirements` を再実行しても、`spec.json` の
`design.approved` / `tasks.approved` は下がりません。`/kiro-spec-design` の再実行も同様で、
design 自身は `approved: false` に戻す一方 `tasks.approved` は放置します。`/kiro-impl` は
**tasks の承認しか見ない**ため、書き換わった上流に対して古い design / tasks のまま実装が
走り得ます。

**運用**: requirements を作り直したら `/kiro-spec-design` → `/kiro-spec-tasks` まで、
design を作り直したら `/kiro-spec-tasks` まで、**必ず下流を通しでやり直す**。

### 完了判定は `tasks.md` を自分で見る

`/kiro-validate-impl` は `[x]` のタスクだけを対象に選ぶため、未完了タスクが残っていても
`GO` が出ることがあります。逆に `/kiro-spec-status` の進捗率は grouping header
（`- [ ] 1.`）も母数に数えるため、実行対象がすべて終わっても 100% になりません。

**運用**: どちらの出力も参考値として扱い、完了判定は `tasks.md` の `X.Y` タスクを直接見る。
なお `/kiro-spec-status` は Step 1 でいきなり `.kiro/specs/$ARGUMENTS/spec.json` を読むため、
**引数なしで呼ぶと「spec が無い」扱いになります**（README が謳う一覧モードに入らない）。
必ず feature 名を渡すこと。

### `/kiro-spec-batch` は失敗した wave の下流を止めない

依存 wave のいずれかが失敗しても次の wave に進むため、前提の spec が欠けたまま下流が生成され得ます。

加えて `/kiro-spec-batch` は、requirements / design / tasks のすべてを生成サブエージェント自身が
承認済みにする（人間のレビューが一切挟まらない）、下流 spec に上流の design を渡さない、
整合性レビューが 3 巡しても収束しないまま finalize する、既存の `tasks.md` があるだけで
「完了」とみなす、といった問題を抱えています。

**運用**: mfmf の規模では `/kiro-spec-batch` は使わない。複数 spec が必要なら 1 本ずつ
`/kiro-spec-init` から回す。

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
