import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, stat, chmod, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { argumentsFor, checkPlan, createPlan, executePlan, FEEDBACK_REPOSITORY, FEEDBACK_REPOSITORY_ID, marker, privateState, validateExport } from "../../scripts/feedback-to-issues.mjs";

const REF = "a".repeat(64);
const TOKEN = "fake-token-only-not-real";
const record = (reference = REF) => ({ reference, kind: "bug", severity: "minor", frequency: "once", page: "record-detail", date: "2026-10-29" });
const exported = (records = [record()]) => ({ schema: 1, source: "mfmf-gcp-feedback", hasMore: false, records });
const repo = (extra = {}) => ({ id: FEEDBACK_REPOSITORY_ID, full_name: FEEDBACK_REPOSITORY, private: true, visibility: "private", archived: false, disabled: false, has_issues: true, ...extra });
function fake({ repository = repo(), issues = [], post, onGet } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    assert.equal(new URL(url).origin, "https://api.github.com");
    assert.equal(options.redirect, "error"); assert.equal(options.credentials, "omit");
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    if (options.method === "POST") {
      if (post) return post(url, options);
      const body = JSON.parse(options.body);
      return Response.json({ number: 12, html_url: `https://github.com/${FEEDBACK_REPOSITORY}/issues/12`, body: body.body }, { status: 201 });
    }
    if (onGet) { const response = onGet(url, calls); if (response) return response; }
    if (url.endsWith(`/repos/${FEEDBACK_REPOSITORY}`)) return Response.json(repository);
    assert.match(url, /\?state=all&per_page=100&sort=created&direction=asc&page=\d+$/);
    return Response.json(issues);
  };
  return { calls, fetchImpl };
}
function memoryState() {
  const entries = new Map();
  return { entries, async write(name, value) { assert.equal(entries.has(name), false, "exclusive fence"); entries.set(name, value); } };
}

test("default arguments are offline dry-run; execute requires an approved digest", () => {
  assert.deepEqual(argumentsFor(["--input=/tmp/export.json"]), { mode: "dry-run", input: "/tmp/export.json" });
  for (const args of [["--execute"], ["--input=x", "--execute"], ["--input=x", "--execute", "--dry-run"],
    ["--input=x", "--input=y"], ["--input=x", "--repo=godhuu0505/mfmf"], ["--input=x", "--repo=godhuu0505/mfmf-feedback"], ["--input=x", "--secret=PRIVATE"]]) {
    assert.throws(() => argumentsFor(args), /details withheld/);
  }
});
test("canonical immutable plan contains only fixed labels, no free-text fields or external URLs", () => {
  const plan = createPlan(exported());
  assert.match(plan.sha256, /^[a-f0-9]{64}$/);
  assert.equal(plan.sha256, createPlan(JSON.parse(JSON.stringify(exported()))).sha256);
  assert.match(plan.issues[0].body, /mfmf-feedback:v1:/);
  assert.deepEqual(plan.issues[0].body.match(/https?:[^)\s]+/g), ["https://mfmf-candidate-wspqvmhj6q-an.a.run.app/feedback"]);
  assert.throws(() => { plan.issues[0].body = "PRIVATE"; });
  assert.throws(() => createPlan(exported(), "godhuu0505/mfmf"));
});
for (const [label, mutate] of [
  ["body", (v) => { v.records[0].body = "PRIVATE"; }],
  ["url", (v) => { v.records[0].page = "https://private.example/path?token=SECRET"; }],
  ["unknown-kind", (v) => { v.records[0].kind = "PRIVATE"; }],
  ["array-enum", (v) => { v.records[0].kind = ["bug"]; }],
  ["prototype", (v) => { v.records[0].kind = "__proto__"; }],
  ["duplicate", (v) => { v.records.push(record()); }],
  ["reference", (v) => { v.records[0].reference = "SECRET"; }],
  ["unknown-source", (v) => { v.source = "supabase"; }],
  ["extra-top-level", (v) => { v.owner_id = "PRIVATE"; }],
  ["bad-date", (v) => { v.records[0].date = "2026-02-30"; }],
  ["too-many", (v) => { v.records = Array.from({ length: 101 }, record); }],
]) test(`export rejects ${label} before any transmission`, () => { const value = exported(); mutate(value); assert.throws(() => validateExport(value), /details withheld/); });

for (const [key, value] of [["private", false], ["visibility", "internal"], ["archived", true], ["disabled", true], ["has_issues", false], ["full_name", "godhuu0505/mfmf"], ["id", null]]) {
  test(`rejects repository ${key} mismatch before issue listing or mutation`, async () => {
    const network = fake({ repository: repo({ [key]: value }) });
    await assert.rejects(checkPlan(createPlan(exported()), { token: TOKEN, ...network }), /details withheld/);
    assert.equal(network.calls.length, 1);
  });
}
test("check uses only GETs and finds closed issues without the search index", async () => {
  const network = fake({ issues: [{ number: 4, state: "closed", body: `fixed\n${marker(REF)}` }] });
  const result = await checkPlan(createPlan(exported()), { token: TOKEN, ...network });
  assert.equal(result.existing.get(REF), 4);
  assert(network.calls.every(({ options }) => options.method === "GET"));
});
test("follows all listing pages and ignores pull requests", async () => {
  const network = fake({ onGet: (url) => new URL(url).searchParams.get("page") === "1" ? Response.json(Array.from({ length: 100 }, (_, n) => ({ number: n + 1, body: n === 0 ? marker(REF) : null, pull_request: {} }))) : undefined,
    issues: [{ number: 101, body: marker(REF) }] });
  const result = await checkPlan(createPlan(exported()), { token: TOKEN, ...network });
  assert.equal(result.existing.get(REF), 101); assert.equal(network.calls.length, 3);
});
test("multiple existing issues with the same marker fail closed", async () => {
  const network = fake({ issues: [{ number: 1, body: marker(REF) }, { number: 2, body: marker(REF) }] });
  await assert.rejects(checkPlan(createPlan(exported()), { token: TOKEN, ...network }));
});
test("execute validates exact approval and incomplete exports before API or journal calls", async () => {
  for (const plan of [createPlan(exported()), createPlan({ ...exported(), hasMore: true })]) {
    const network = fake(); const state = memoryState();
    await assert.rejects(executePlan(plan, { approvedSha: "b".repeat(64), token: TOKEN, state, ...network }));
    assert.equal(network.calls.length, 0); assert.equal(state.entries.size, 0);
  }
  const network = fake(); const state = memoryState(); const plan = createPlan({ ...exported(), hasMore: true });
  await assert.rejects(executePlan(plan, { approvedSha: plan.sha256, token: TOKEN, state, ...network }));
  assert.equal(network.calls.length, 0);
});
test("a plain/forged plan cannot inject arbitrary issue text", async () => {
  const plan = JSON.parse(JSON.stringify(createPlan(exported()))); plan.issues[0].body = "PRIVATE";
  const network = fake();
  await assert.rejects(executePlan(plan, { approvedSha: plan.sha256, token: TOKEN, state: memoryState(), ...network }));
  assert.equal(network.calls.length, 0);
});
test("writes intent before the single POST, then a separate completion; no DB call", async () => {
  const state = memoryState(); const plan = createPlan(exported());
  const network = fake({ post: (_url, options) => {
    assert.equal(state.entries.size, 1); assert.match([...state.entries.keys()][0], /intent.json$/);
    return Response.json({ number: 12, html_url: `https://github.com/${FEEDBACK_REPOSITORY}/issues/12`, body: JSON.parse(options.body).body }, { status: 201 });
  } });
  assert.deepEqual(await executePlan(plan, { approvedSha: plan.sha256, token: TOKEN, state, ...network }), { created: 1, skipped: 0 });
  assert.equal(network.calls.filter((call) => call.options.method === "POST").length, 1);
  assert.equal(state.entries.size, 2); assert.doesNotMatch(JSON.stringify([...state.entries]), /fake-token|https/);
});
test("existing closed issue skips without creating a local intent", async () => {
  const state = memoryState(); const plan = createPlan(exported());
  const network = fake({ issues: [{ number: 1, state: "closed", body: marker(REF) }] });
  assert.deepEqual(await executePlan(plan, { approvedSha: plan.sha256, token: TOKEN, state, ...network }), { created: 0, skipped: 1 });
  assert.equal(state.entries.size, 0);
});
test("rechecks private repository and stable id before each POST", async () => {
  const state = memoryState(); const plan = createPlan(exported([record(), record("b".repeat(64))]));
  let lookups = 0;
  const network = fake({ onGet: (url) => {
    if (url.endsWith(`/repos/${FEEDBACK_REPOSITORY}`) && ++lookups === 2) return Response.json(repo({ id: 999 }));
  } });
  await assert.rejects(executePlan(plan, { approvedSha: plan.sha256, token: TOKEN, state, ...network }));
  assert.equal(network.calls.filter((call) => call.options.method === "POST").length, 1);
});
for (const [label, post] of [
  ["network", () => { throw new Error("SECRET"); }],
  ["http", () => new Response("PRIVATE", { status: 429 })],
  ["invalid-json", () => new Response("PRIVATE", { status: 201 })],
  ["wrong-url", () => Response.json({ number: 3, html_url: "https://evil.example/SECRET", body: marker(REF) }, { status: 201 })],
  ["missing-marker", () => Response.json({ number: 3, html_url: `https://github.com/${FEEDBACK_REPOSITORY}/issues/3`, body: "PRIVATE" }, { status: 201 })],
]) test(`${label} leaves a fence and prevents a second POST on rerun`, async () => {
  const state = memoryState(); const plan = createPlan(exported()); const network = fake({ post });
  for (let n = 0; n < 2; n++) await assert.rejects(executePlan(plan, { approvedSha: plan.sha256, token: TOKEN, state, ...network }), (error) => !/SECRET|PRIVATE/.test(error.message));
  assert.equal(network.calls.filter((call) => call.options.method === "POST").length, 1);
  assert.equal(state.entries.size, 1);
});
test("a lost response followed by a discoverable marker skips safely on rerun", async () => {
  const state = memoryState(); const plan = createPlan(exported());
  await assert.rejects(executePlan(plan, { approvedSha: plan.sha256, token: TOKEN, state, ...fake({ post: () => { throw new Error("lost"); } }) }));
  const network = fake({ issues: [{ number: 9, body: marker(REF) }] });
  assert.deepEqual(await executePlan(plan, { approvedSha: plan.sha256, token: TOKEN, state, ...network }), { created: 0, skipped: 1 });
});
test("a full page bound never becomes a partial deduplication success", async () => {
  const network = fake({ issues: Array.from({ length: 100 }, (_, n) => ({ number: n + 1, body: null })) });
  await assert.rejects(checkPlan(createPlan(exported()), { token: TOKEN, ...network }));
  assert.equal(network.calls.length, 101);
});
test("oversized or failed GitHub responses withhold body content", async () => {
  for (const response of [new Response("PRIVATE", { status: 403 }), new Response("PRIVATE".repeat(400000), { status: 200 })]) {
    await assert.rejects(checkPlan(createPlan(exported()), { token: TOKEN, fetchImpl: async () => response }), (error) => !error.message.includes("PRIVATE"));
  }
});
test("durable journal is exclusive, private and rejects symlink directories", async () => {
  const directory = await mkdtemp(`${tmpdir()}/feedback-state-`);
  try {
    const state = await privateState(directory);
    await state.write("fixture.intent.json", { state: "attempted" });
    assert.equal((await stat(`${directory}/fixture.intent.json`)).mode & 0o777, 0o600);
    await assert.rejects(state.write("fixture.intent.json", {}));
    await symlink(directory, `${directory}-link`);
    await assert.rejects(privateState(`${directory}-link`));
    await chmod(directory, 0o755);
    await assert.rejects(privateState(directory));
  } finally { await rm(`${directory}-link`, { force: true }); await rm(directory, { recursive: true, force: true }); }
});
test("CLI default works without credentials and invalid input never logs private values", async () => {
  const directory = await mkdtemp(`${tmpdir()}/feedback-cli-`);
  const script = fileURLToPath(new URL("../../scripts/feedback-to-issues.mjs", import.meta.url));
  try {
    const input = `${directory}/export.json`; await writeFile(input, JSON.stringify(exported()), { mode: 0o600 });
    const run = () => spawnSync(process.execPath, [script, `--input=${input}`], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
    let result = run(); assert.equal(result.status, 0); assert.equal(JSON.parse(result.stdout).mode, "dry-run");
    await writeFile(input, JSON.stringify({ ...exported(), secret: "PRIVATE-MARKER" }));
    result = run(); assert.equal(result.status, 1); assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE-MARKER/);
    assert.equal(result.stdout, "");
    await writeFile(input, "PRIVATE-MARKER"); result = run(); assert.equal(result.status, 1); assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE-MARKER/);
    assert.match(await readFile(script, "utf8"), /No app password/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
