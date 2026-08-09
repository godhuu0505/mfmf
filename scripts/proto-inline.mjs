// proto/<slug>/proto.css を index.html の <!-- proto.css:start --> ... :end に埋め込む。
// Artifact は外部ファイルを読めないため（.claude/skills/prototype/SKILL.md）。
import { readFileSync, writeFileSync } from "node:fs";
const slug = process.argv[2];
if (!slug) throw new Error("usage: node scripts/proto-inline.mjs <slug>");
const htmlPath = `proto/${slug}/index.html`;
const html = readFileSync(htmlPath, "utf8");
const css = readFileSync(`proto/${slug}/proto.css`, "utf8");
const marker = /<!-- proto\.css:start -->[\s\S]*?<!-- proto\.css:end -->/;
// 差し替え結果が入力と同じでも「マーカーが無い」とは限らない（CSS が前回と同一なら
// 一致する）ので、マーカーの有無は置換結果ではなく正規表現で直接確かめる。
if (!marker.test(html)) {
  throw new Error(`${htmlPath} にマーカー <!-- proto.css:start --> … <!-- proto.css:end --> がありません`);
}
// 置換文字列ではなくコールバックで差し込む。文字列だと CSS 中の `$&` や `$1`
// （content や url() に入りうる）が置換パターンとして解釈され、HTML が壊れる。
const out = html.replace(
  marker,
  () => `<!-- proto.css:start -->\n<style>\n${css}</style>\n<!-- proto.css:end -->`,
);
if (out === html) {
  console.log(`proto/${slug}/index.html は最新です（CSS ${css.length} bytes、変更なし）`);
} else {
  writeFileSync(htmlPath, out);
  console.log(`inlined ${css.length} bytes of CSS into ${htmlPath}`);
}
