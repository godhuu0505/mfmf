// Generate the standalone prototype with the installed Tailwind PostCSS compiler.
// No network requests, package changes, or application data are needed.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../..');
const globals = await fs.readFile(path.join(root, 'src/app/globals.css'), 'utf8');
const tokens = globals.slice(globals.indexOf('@source not "../../proto";') + '@source not "../../proto";'.length);
const explicitThemes = execFileSync(process.execPath, ['scripts/proto-theme-tokens.mjs'], { cwd: root, encoding: 'utf8' });
const source = `@import "tailwindcss" source(none);
@source "./index.html";
@custom-variant dark {
  @media (prefers-color-scheme: dark) { &:where(:not([data-theme="light"] *)) { @slot; } }
  &:where([data-theme="dark"] *) { @slot; }
}
${tokens}
${explicitThemes}
@media print {
  :root, :root[data-theme] {
    --background: #fff; --foreground: #111827; --surface: #fff;
    --surface-muted: #f1f5f9; --border-color: #cbd5e1; --muted-foreground: #475569;
    --primary: #9a3412; color-scheme: light;
  }
  body { padding: 0; }
}
@page { margin: 12mm; }
`;
const result = await postcss([tailwind({ base: root })]).process(source, { from: path.join(directory, 'input.css') });
const htmlPath = path.join(directory, 'index.html');
const html = await fs.readFile(htmlPath, 'utf8');
await fs.writeFile(path.join(directory, 'proto.css'), result.css);
await fs.writeFile(htmlPath, html.replace(/<!-- proto\.css:start -->[\s\S]*?<!-- proto\.css:end -->/, `<!-- proto.css:start -->\n<style>\n${result.css}\n</style>\n<!-- proto.css:end -->`));
console.log('Care summary prototype CSS generated and embedded.');
