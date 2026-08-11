// globals.css のセマンティックトークンを :root[data-theme] にも配る CSS を吐く。
// 本番はシステム設定（prefers-color-scheme）だけを見るが、Artifact のビューアは
// 明暗を data-theme で明示することがある。片方だけ切り替わると、明るい面に
// 暗い文字のような混ざった配色になるため、プロトの CSS にはこれを足しておく。
// color-scheme も一緒に固定する。globals.css の `color-scheme: light dark` は
// システム設定に従うので、これが無いと時刻入力やチェックボックスの内側だけが
// 明るいまま暗い面に乗る。
import { readFileSync } from "node:fs";

const css = readFileSync("src/app/globals.css", "utf8");
const light = css.match(/\n:root \{\n([\s\S]*?)\n\}/);
const dark = css.match(/@media \(prefers-color-scheme: dark\) \{\n {2}:root \{\n([\s\S]*?)\n {2}\}/);
if (!light || !dark) {
  throw new Error("globals.css の :root / prefers-color-scheme のトークン定義が見つかりません");
}
const dedent = (s) => s.replace(/^ {2}/gm, "");
process.stdout.write(
  `/* Artifact のビューアは明暗を :root[data-theme] で明示することがある。\n` +
    `   globals.css と同じ値を配って、トークンと dark: の片方だけが\n` +
    `   切り替わるのを防ぐ（scripts/proto-theme-tokens.mjs が生成） */\n` +
    `:root[data-theme="light"] {\n${light[1]}\n  color-scheme: light;\n}\n` +
    `:root[data-theme="dark"] {\n${dedent(dark[1])}\n  color-scheme: dark;\n}\n`,
);
