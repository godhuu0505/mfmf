// Read tracked source only. Never imports application code or contacts a service.
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const LIMITATIONS = [
  "Syntactic candidates, not type-resolved SDK calls: wrappers, aliases and other SDKs may cause omissions or false positives.",
  "Dynamic targets/member calls require manual review; names and argument values are withheld.",
  "SQL references are lexical matches, including comments/string literals and historical migrations; they do not describe the effective schema or active policies.",
  "No live DB, auth users, object contents, IAM, checksums, row counts or runtime authorization were examined.",
  "A zero count or successful exit does not establish migration readiness. Raw HTTP, shell scripts and generated/untracked source need separate review.",
];
const staticName = (node) => {
  if (!node) return undefined;
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
};
function memberParts(node) {
  if (ts.isIdentifier(node)) return [node.text];
  if (ts.isCallExpression(node)) return memberParts(node.expression);
  if (ts.isPropertyAccessExpression(node)) {
    const head = memberParts(node.expression);
    return head ? [...head, node.name.text] : undefined;
  }
  if (ts.isElementAccessExpression(node)) {
    const head = memberParts(node.expression);
    // Identifier index is dynamic (client[method]), unlike client["rpc"].
    const key = node.argumentExpression;
    return head && key && (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) ? [...head, key.text] : undefined;
  }
}

export function inspectSource(path, source) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : path.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  if (file.parseDiagnostics.length) throw new Error("Source parsing failed; diagnostic text withheld.");
  const calls = [], imports = [], dynamicMembers = [];
  const clientModule = file.statements.some((s) => ts.isExpressionStatement(s) && ts.isStringLiteral(s.expression) && s.expression.text === "use client");
  const at = (node) => ({ path, line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1 });
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const module = staticName(node.moduleSpecifier);
      if (module && (module.startsWith("@supabase/") || module.startsWith("@/lib/supabase/"))) imports.push({ ...at(node), module });
    }
    if (ts.isCallExpression(node)) {
      const parts = memberParts(node.expression);
      if (!parts && ts.isElementAccessExpression(node.expression)) dynamicMembers.push(at(node));
      const method = parts?.at(-1);
      let category;
      if (parts?.at(-2) === "auth") category = "auth";
      else if (parts?.includes("storage") && !["from", "then", "catch", "finally"].includes(method)) category = "storage";
      else if (method === "from" && parts?.includes("storage")) category = "storage-bucket";
      else if (method === "rpc") category = "rpc";
      else if (method === "from" && !["Array", "Buffer", "Uint8Array", "String"].includes(parts?.[0])) category = "table";
      if (category) {
        const record = { ...at(node), category, method, clientModule };
        if (["table", "rpc", "storage-bucket"].includes(category)) {
          const arg = node.arguments[0];
          const literal = arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) ? arg.text : undefined;
          // Only identifier-shaped labels. Never serialize SQL, expressions or values.
          if (literal && /^[a-z][a-z0-9_-]{0,79}$/.test(literal)) record.target = { kind: "literal", name: literal };
          else record.target = { kind: "unresolved" };
        }
        calls.push(record);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { imports, calls, dynamicMembers };
}

export function inspectSql(path, source) {
  // Deliberately lexical: preserve evidence of dependencies inside PL/pgSQL bodies,
  // but never emit SQL text or string values. Effective schema needs DB rehearsal.
  const references = [];
  const pattern = /\b(auth|storage)\s*\.\s*(users|identities|uid|jwt|role|objects|buckets|foldername)\b/gi;
  for (const match of source.matchAll(pattern)) references.push({ path, line: source.slice(0, match.index).split("\n").length, dependency: `${match[1].toLowerCase()}.${match[2].toLowerCase()}` });
  return references;
}

export function inventory(files, revision = "unavailable") {
  const imports = [], calls = [], dynamicMembers = [], sqlReferences = [], pgTapFiles = [], shellScripts = [];
  for (const { path, source } of [...files].sort((a, b) => a.path.localeCompare(b.path, "en"))) {
    if (/^(src|scripts)\/.*\.(tsx?|m?js)$/.test(path)) {
      const found = inspectSource(path, source);
      imports.push(...found.imports); calls.push(...found.calls); dynamicMembers.push(...found.dynamicMembers);
    } else if (/^supabase\/(migrations|tests)\/.*\.sql$/.test(path)) {
      sqlReferences.push(...inspectSql(path, source));
      if (path.startsWith("supabase/tests/")) pgTapFiles.push(path);
    } else if (/^scripts\/.*\.sh$/.test(path)) shellScripts.push(path);
  }
  return {
    formatVersion: 1, kind: "static-review-inventory", readiness: "not-assessed", revision,
    limitations: LIMITATIONS,
    summary: {
      scannedFiles: files.length, sdkImports: imports.length,
      callCandidates: Object.fromEntries(["table", "rpc", "auth", "storage-bucket", "storage"].map((category) => [category, calls.filter((c) => c.category === category).length])),
      unresolvedTargets: calls.filter((c) => c.target?.kind === "unresolved").length,
      dynamicMemberCalls: dynamicMembers.length, sqlLexicalReferences: sqlReferences.length, pgTapFiles: pgTapFiles.length,
    },
    imports, calls, dynamicMembers, sqlReferences, pgTapFiles, shellScripts,
  };
}

export function collectTrackedFiles(root) {
  const paths = execFileSync("git", ["ls-files", "-z", "--", "src", "scripts", "supabase/migrations", "supabase/tests"], { cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024 }).split("\0").filter(Boolean);
  return paths.filter((path) => /^(src|scripts)\/.*\.(tsx?|m?js|sh)$/.test(path) || /^supabase\/(migrations|tests)\/.*\.sql$/.test(path)).map((path) => {
    if (path.split("/").some((part) => part.startsWith(".env") || part === "..")) throw new Error("Disallowed source path.");
    const full = resolve(root, path);
    if (!full.startsWith(`${root}${sep}`) || !lstatSync(full).isFile() || lstatSync(full).isSymbolicLink()) throw new Error("Source must be a regular file inside the repository.");
    // Reject a symlink in any parent too, before reading contents.
    let parent = dirname(full);
    while (parent !== root) {
      if (lstatSync(parent).isSymbolicLink()) throw new Error("Symlink source directory rejected.");
      parent = dirname(parent);
    }
    return { path, source: readFileSync(full, "utf8") };
  });
}

export function main(args = process.argv.slice(2)) {
  if (args.length) {
    process.stderr.write("Usage: node scripts/gcp/migration-inventory.mjs (no arguments; tracked source only)\n");
    return 1;
  }
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    process.stdout.write(`${JSON.stringify(inventory(collectTrackedFiles(root), revision), null, 2)}\n`);
    return 0;
  } catch {
    // Do not print parser diagnostics, file contents or subprocess stderr.
    process.stderr.write("Inventory failed. Check tracked source paths and syntax; diagnostic details withheld.\n");
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main();
