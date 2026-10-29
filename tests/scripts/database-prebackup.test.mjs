import test from "node:test";
import assert from "node:assert/strict";
import { ensurePreMigrationBackup } from "../../scripts/gcp/database-prebackup.mjs";
import { API, META, CLOCK, SHA, backup, receipt, instance, fixture } from "./helpers/database-retention-fixture.mjs";
const env = { CLOUD_RUN_JOB: "mfmf-db-operator", MFMF_DB_OPERATION: "upgrade", MFMF_DB_DEPLOY_SHA: SHA };
const run = (f, extra = {}) => ensurePreMigrationBackup({ env, accessToken: "PRIVATE_TOKEN", fetchImpl: f.fetchImpl, now: () => CLOCK, wait: async () => {}, maxPolls: 2, ...extra });
const other = (id, extra = {}) => backup(`other-${id}`, 0, { description: "other-marker", ...extra });
const posts = (f) => f.state.calls.filter(c => c.init.method === "POST");
test("Standard null expiry is allowed only with verified external retention; summaries are hydrated", async () => {
  const f = await fixture({ saved: backup("fixture", 0, { expiryTime: null }) });
  assert.deepEqual(await run(f), { verified: true, retentionMode: "verified-external-cleanup", minimumRetentionDays: 14, cleanupReceiptMaximumAgeHours: 30 });
  assert.equal(posts(f).length, 1);
  assert.deepEqual(JSON.parse(posts(f)[0].init.body), { instance: "mfmf-db", description: `mfmf-managed-preupgrade-v1:${SHA}`, location: "asia-northeast1", ttlDays: "14" });
  assert.ok(f.state.calls.some(c => c.url.endsWith("/backups/fixture") && c.init.method === "GET"));
  assert.ok(f.state.calls.every(c => c.init.redirect === "error" && c.init.headers["X-Goog-User-Project"] === "mfmf-499612"));
});
test("same recent SHA reuses one immutable backup without creating", async () => {
  const f = await fixture({ rows: [backup()] }); await run(f); assert.equal(posts(f).length, 0);
});
for (const change of [{ expiryTime: "2029-01-01T00:00:00Z" }, { expiryTime: "2026-10-28T12:00:00Z" },
  { instance: "other" }, { location: "us" }, { state: "FAILED" }, { type: "AUTOMATED" }, { description: "PRIVATE" }, { name: "https://attacker.invalid" }]) {
  test(`rejects returned backup drift ${JSON.stringify(change)}`, async () => {
    const f = await fixture({ saved: backup("fixture", 0, change) }); await assert.rejects(run(f), /stage=(verify-backup|backup-operation)/);
  });
}
test("old, missing, future, reversed start or end does not authorize SQL or create a retry duplicate", async () => {
  for (const interval of [{ endTime: new Date(CLOCK).toISOString() }, { startTime: "PRIVATE", endTime: "PRIVATE" },
    { startTime: new Date(CLOCK - 960000).toISOString(), endTime: new Date(CLOCK).toISOString() },
    { startTime: new Date(CLOCK + 60000).toISOString(), endTime: new Date(CLOCK + 60000).toISOString() },
    { startTime: new Date(CLOCK + 1000).toISOString(), endTime: new Date(CLOCK).toISOString() },
    { startTime: new Date(CLOCK).toISOString() }]) {
    const f = await fixture({ rows: [backup("fixture", 0, { backupInterval: interval })] });
    await assert.rejects(run(f), /stage=verify-backup/); assert.equal(posts(f).length, 0);
  }
});
test("created backup must start after request tolerance; reuse may be up to 15 minutes old", async () => {
  const b = backup("fixture", 0, { backupInterval: { startTime: new Date(CLOCK - 60000).toISOString(), endTime: new Date(CLOCK).toISOString() } });
  await assert.rejects(run(await fixture({ saved: b })), /stage=verify-backup/);
  await run(await fixture({ rows: [b] }));
});
test("every marker counts toward capacity; exactly eight permits reuse but not creation", async () => {
  const f = await fixture({ rows: Array.from({ length: 8 }, (_, i) => other(i)) });
  await assert.rejects(run(f), /capacity/); assert.equal(posts(f).length, 0);
  await run(await fixture({ rows: [backup(), ...Array.from({ length: 7 }, (_, i) => other(i))] }));
  await assert.rejects(run(await fixture({ rows: Array.from({ length: 9 }, (_, i) => other(i)) })), /capacity/);
});
test("unknown and invalid detailed bytes fail closed; list omission alone is supported", async () => {
  for (const maxChargeableBytes of [undefined, null, 10, "-1", "1.5", "01", "PRIVATE_BYTES", "99999999999999999999", "1073741824"]) {
    const f = await fixture({ rows: [other(1, { maxChargeableBytes })] });
    await assert.rejects(run(f), e => /capacity/.test(e.message) && !/PRIVATE/.test(e.message)); assert.equal(posts(f).length, 0);
  }
});
test("new size and final full inventory cannot exceed one GiB", async () => {
  const f = await fixture({ rows: [other(1, { maxChargeableBytes: "1073741820" })] });
  await assert.rejects(run(f), /capacity/); assert.equal(posts(f).length, 1);
});
test("automated and final snapshots do not use manual capacity and are never mutated", async () => {
  const f = await fixture({ rows: [other(1, { type: "AUTOMATED" }), other(2, { type: "FINAL" })] });
  await run(f); assert.equal(posts(f).length, 1); assert.equal(f.state.deleted.length, 0);
});
test("all pages are hydrated before the capacity check", async () => {
  const rows = Array.from({ length: 8 }, (_, i) => other(i));
  const f = await fixture({ rows, hook: (url) => {
    if (!url.startsWith(`${API}/backups?`)) return;
    const second = new URL(url).searchParams.has("pageToken");
    return Response.json({ backups: rows.slice(second ? 4 : 0, second ? 8 : 4).map(({ name, instance, type }) => ({ name, instance, type })), ...(second ? {} : { nextPageToken: "next" }) });
  } });
  await assert.rejects(run(f), /capacity/); assert.equal(posts(f).length, 0);
});
test("duplicate markers, foreign summaries, cyclic/partial lists stop without create", async () => {
  for (const payload of [{ backups: [backup(), backup()] }, { backups: [other(1, { instance: "other" })] },
    { backups: [], warnings: ["PRIVATE"] }, { backups: [], nextPageToken: "repeat" }]) {
    const f = await fixture({ hook: url => url.startsWith(`${API}/backups?`) ? Response.json(payload) : undefined });
    await assert.rejects(run(f), /stage=list/); assert.equal(posts(f).length, 0);
  }
  const f = await fixture({ rows: [backup("a"), backup("b")] }); await assert.rejects(run(f), /stage=list/); assert.equal(posts(f).length, 0);
});
test("pending same marker and foreign operation cannot authorize or create duplicates", async () => {
  const f = await fixture({ rows: [backup("a", 0, { state: "RUNNING" })] }); await assert.rejects(run(f)); assert.equal(posts(f).length, 0);
  for (const operation of [{ targetProject: "other" }, { targetId: "other" }, { name: "../other" }, { backupContext: { name: "projects/other/backups/private" } }]) {
    await assert.rejects(run(await fixture({ operation })), /stage=backup-operation/);
  }
});
test("missing, stale, future, foreign birth, changed implementation or non-success receipt fails before creating", async () => {
  for (const proof of [null, await receipt({ startedAt: new Date(CLOCK - 31 * 3600000).toISOString() }),
    await receipt({ completedAt: new Date(CLOCK + 1000).toISOString() }), await receipt({ status: "running" }),
    await receipt({ instanceCreateTime: "2025-01-01T00:00:00Z" }), await receipt({ implementationSha256: "b".repeat(64) }), await receipt({ extra: "PRIVATE" })]) {
    const f = await fixture({ proof }); await assert.rejects(run(f), e => !/PRIVATE/.test(e.message)); assert.equal(posts(f).length, 0);
  }
});
test("receipt generation drift after backup completion fails closed", async () => {
  let reads = 0;
  const f = await fixture({ hook: (url, _init, state) => { if (url === META && ++reads === 2) state.generation = "101"; } });
  await assert.rejects(run(f), /retention-drift/); assert.equal(posts(f).length, 1);
});
test("instance birth/config drift and wrong context cannot reach create", async () => {
  const resource = instance(); resource.settings.ipConfiguration.ipv4Enabled = true;
  const f = await fixture({ resource }); await assert.rejects(run(f), /instance/); assert.equal(posts(f).length, 0);
  const clean = await fixture(); await assert.rejects(run(clean, { env: { ...env, MFMF_DB_OPERATION: "migrate" } }), /context/); assert.equal(clean.state.calls.length, 0);
});
test("provider failures and lost create responses never expose raw bodies or retry", async () => {
  for (const mode of ["body", "throw"]) {
    const f = await fixture({ hook: (url, init) => {
      if (url === `${API}/backups` && init.method === "POST") {
        if (mode === "throw") throw new Error("PRIVATE");
        return new Response("PRIVATE", { status: 400 });
      }
    } });
    await assert.rejects(run(f), e => /create-backup/.test(e.message) && !/PRIVATE/.test(e.message)); assert.equal(posts(f).length, 1);
  }
});
