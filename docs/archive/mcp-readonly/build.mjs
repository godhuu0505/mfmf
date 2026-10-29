// Build the isolated HTML prototype using the already installed Tailwind compiler.
// This reads design tokens only; it never loads application configuration or data.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, "../../..");
const globals = await fs.readFile(path.join(root, "src/app/globals.css"), "utf8");
const marker = '@source not "../../proto";';
if (!globals.includes(marker)) throw new Error("Prototype exclusion marker is missing");
const tokens = globals.slice(globals.indexOf(marker) + marker.length);
const themes = execFileSync(process.execPath, ["scripts/proto-theme-tokens.mjs"], { cwd: root, encoding: "utf8" });
const source = `@import "tailwindcss" source(none);
@source "./index.html";
@custom-variant dark {
  @media (prefers-color-scheme: dark) { &:where(:not([data-theme="light"] *)) { @slot; } }
  &:where([data-theme="dark"] *) { @slot; }
}
${tokens}
${themes}`;
const result = await postcss([tailwind({ base: root })]).process(source, { from: path.join(directory, "input.css") });
const htmlPath = path.join(directory, "index.html");
const html = await fs.readFile(htmlPath, "utf8");
await fs.writeFile(path.join(directory, "proto.css"), result.css);
await fs.writeFile(htmlPath, html.replace(/<!-- proto\.css:start -->[\s\S]*?<!-- proto\.css:end -->/, `<!-- proto.css:start -->\n<style>\n${result.css}\n</style>\n<!-- proto.css:end -->`));
process.stdout.write("Prototype CSS generated and embedded.\n");
