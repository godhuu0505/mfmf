# proto/ — 画面プロトタイプの置き場

UI のある新機能は、仕様を文章で固める前にここへ**自己完結した静的 HTML/CSS/JS** の
プロトタイプを置き、Claude Artifact に publish してスマホで触って合意します
（[D24](../docs/explanation/decisions.md)）。

手順は [`.claude/skills/prototype/SKILL.md`](../.claude/skills/prototype/SKILL.md)。

```
proto/<slug>/
├── index.html      ← 単一ファイル。複数案なら a.html / b.html / c.html
├── proto.css       ← Tailwind CLI が生成（HTML に <style> で埋め込む）
├── notes.md        ← 何を確かめたいか
└── spec.md         ← 合意後に書く。ユーザーから見える振る舞いだけ
```

## 約束ごと

- **実 API・実 DB を呼ばない。** `fetch` を書かない。データは JS の固定配列でモックする
- **本番と同じ Tailwind クラス名を使う。** 実装時の移植が `class` → `className` の
  機械変換で済む。独自クラス名や inline style を使うとこの利点が消える
- **本番ビルドには影響しない。** `src/app/globals.css` の `@source not "proto/"` で
  このディレクトリを Tailwind の走査対象から外してある

## ライフサイクル

PR にはこのまま含めます（レビューで実物を見るため）。マージ後は
[`docs/archive/`](../docs/archive/) へ移します —— 削除はしません（[D27](../docs/explanation/decisions.md)）。

> ⚠️ **移動を自動化する CI はまだありません。** 当面は手で移動してください。
