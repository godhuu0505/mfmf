// proto/<slug>/proto.css を index.html の <!-- proto.css:start --> ... :end に埋め込む。
// Artifact は外部ファイルを読めないため（.claude/skills/prototype/SKILL.md）。
import { readFileSync, writeFileSync } from "node:fs";
const slug = process.argv[2];
if (!slug) throw new Error("usage: node scripts/proto-inline.mjs <slug>");
const html = readFileSync(`proto/${slug}/index.html`, "utf8");
const css = readFileSync(`proto/${slug}/proto.css`, "utf8");
const out = html.replace(
  /<!-- proto\.css:start -->[\s\S]*?<!-- proto\.css:end -->/,
  `<!-- proto.css:start -->\n<style>\n${css}</style>\n<!-- proto.css:end -->`,
);
if (out === html) throw new Error("マーカー <!-- proto.css:start/end --> が見つかりません");
writeFileSync(`proto/${slug}/index.html`, out);
console.log(`inlined ${css.length} bytes of CSS into proto/${slug}/index.html`);
