import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectSource, inspectSql, inventory, collectTrackedFiles } from "../../scripts/gcp/migration-inventory.mjs";

test("AST excludes comments/string contents and Array.from, detects multiline/optional/static computed calls", () => {
  const result = inspectSource("src/example.tsx", `"use client";
import { createClient as make } from "@/lib/supabase/client";
// client.rpc("comment_only")
const example = 'client.from("string_only")';
Array.from([]);
client?.from(\n"daycare_records"\n).select("private value");
client["rpc"]("delete_plan", { p_record: "private-uuid" });
client.auth.getUser();
client.storage.from("avatars").upload("private/object/path", bytes).catch(() => {});
`);
  assert.deepEqual(result.calls.map((c) => c.category), ["table", "rpc", "auth", "storage", "storage-bucket"]);
  assert.ok(result.calls.every((c) => c.clientModule));
  assert.equal(result.imports.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /comment_only|string_only|private value|private-uuid|private\/object/);
});

test("dynamic targets are explicit, while raw SQL and expressions are withheld", () => {
  const result = inspectSource("src/example.ts", `client.from(tableName); client.rpc("SELECT 'private email'"); client[method](secret); client.storage.from(BUCKET).remove([privatePath]);`);
  assert.equal(result.calls.filter((c) => c.target?.kind === "unresolved").length, 3);
  assert.equal(result.dynamicMembers.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /tableName|SELECT|private email|secret|privatePath|BUCKET/);
});

test("SQL emits only known dependency names, including function body references, with lexical limits", () => {
  const result = inspectSql("supabase/migrations/fixture.sql", `create function public.f() returns void as $$ begin perform auth.uid(); end $$ language plpgsql;\nselect 'personal@example.invalid' from auth.users;\n-- storage.objects is a historical dependency`);
  assert.deepEqual(result.map((r) => r.dependency), ["auth.uid", "auth.users", "storage.objects"]);
  assert.doesNotMatch(JSON.stringify(result), /personal|perform|returns/);
});

test("empty inventories never claim migration readiness; pgTAP and shell scripts stay visible", () => {
  const result = inventory([{ path: "supabase/tests/example.sql", source: "select 1" }, { path: "scripts/admin.sh", source: "echo private" }]);
  assert.equal(result.readiness, "not-assessed");
  assert.equal(result.summary.callCandidates.table, 0);
  assert.deepEqual(result.pgTapFiles, ["supabase/tests/example.sql"]);
  assert.deepEqual(result.shellScripts, ["scripts/admin.sh"]);
  assert.match(result.limitations.join(" "), /zero count/);
  assert.doesNotMatch(JSON.stringify(result), /echo private/);
});

test("syntax errors fail without echoing source", () => {
  assert.throws(() => inspectSource("src/broken.ts", "const secret = 'private-value;"), /diagnostic text withheld/);
});

test("file collection reads tracked allowlisted source only and rejects symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "mfmf-inventory-"));
  try {
    mkdirSync(join(root, "src"));
    execFileSync("git", ["init", "-q", root]);
    writeFileSync(join(root, ".env.local"), "private-value");
    writeFileSync(join(root, "src", "untracked.ts"), "private-untracked");
    writeFileSync(join(root, "src", "safe.ts"), "export const answer = 42;");
    execFileSync("git", ["add", "src/safe.ts", ".env.local"], { cwd: root });
    assert.deepEqual(collectTrackedFiles(root).map((f) => f.path), ["src/safe.ts"]);
    symlinkSync("../.env.local", join(root, "src", "linked.ts"));
    execFileSync("git", ["add", "src/linked.ts"], { cwd: root });
    assert.throws(() => collectTrackedFiles(root), /regular file/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
