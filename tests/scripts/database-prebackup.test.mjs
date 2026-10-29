import test from "node:test";
import assert from "node:assert/strict";
import { ensurePreMigrationBackup } from "../../scripts/gcp/database-prebackup.mjs";
const sha = "a".repeat(40);
const env = { CLOUD_RUN_JOB: "mfmf-db-operator", MFMF_DB_OPERATION: "upgrade", MFMF_DB_DEPLOY_SHA: sha };
const clock = Date.parse("2026-10-28T00:00:00Z");
const name = "projects/mfmf-499612/backups/fixture-backup";
const backup = () => ({ name, instance: "mfmf-db", description: `mfmf-managed-preupgrade-v1:${sha}`,
  type: "ON_DEMAND", state: "SUCCESSFUL", location: "asia-northeast1", expiryTime: new Date(clock + 14 * 86400000).toISOString(),
  maxChargeableBytes: "1000",
  backupInterval: { startTime: new Date(clock).toISOString(), endTime: new Date(clock).toISOString() } });
const operation = () => ({ name: "fixture-operation", targetProject: "mfmf-499612", targetId: "mfmf-db",
  operationType: "BACKUP_VOLUME", status: "DONE", backupContext: { name } });
function fixture({ list = [], saved = backup(), op = operation(), failStatus } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.redirect, "error");
    assert.equal(init.headers["X-Goog-User-Project"], "mfmf-499612");
    if (failStatus) return new Response("PRIVATE_PROVIDER_BODY", { status: failStatus });
    if (url.includes("?")) return Response.json({ backups: list });
    if (init.method === "POST" || url.includes("/operations/")) return Response.json(op);
    if (url.endsWith("/fixture-backup")) return Response.json(saved);
    throw new Error("PRIVATE_UNEXPECTED_URL");
  };
  return { calls, run: (extra = {}) => ensurePreMigrationBackup({ env, accessToken: "PRIVATE_TOKEN", fetchImpl,
    now: () => clock, wait: async () => {}, maxPolls: 2, ...extra }) };
}
test("creates fixed 14-day backup and verifies final resource before returning", async () => {
  const f = fixture(); assert.deepEqual(await f.run(), { verified: true, retentionDaysMaximum: 14 });
  assert.equal(f.calls.length, 3);
  assert.deepEqual(JSON.parse(f.calls[1].init.body), { instance: "mfmf-db", description: `mfmf-managed-preupgrade-v1:${sha}`,
    location: "asia-northeast1", ttlDays: "14" });
});
test("retry reuses the same verified SHA marker without writes", async () => {
  const f = fixture({ list: [backup()] }); await f.run(); assert.ok(f.calls.every(({ init }) => init.method === "GET"));
});
for (const change of [{ expiryTime: undefined }, { expiryTime: "2029-01-01T00:00:00Z" }, { expiryTime: "2026-10-28T12:00:00Z" },
  { instance: "other" }, { location: "us" }, { state: "FAILED" }, { type: "AUTOMATED" }, { description: "PRIVATE" }, { name: "https://attacker.invalid" }]) {
  test(`rejects backup drift ${Object.keys(change)[0]} ${JSON.stringify(change)}`, async () => {
    const f = fixture({ saved: { ...backup(), ...change } }); await assert.rejects(f.run(), /stage=verify-backup/);
  });
}
test("old or future same-SHA backups never create another backup or authorize SQL", async () => {
  for (const endTime of [undefined, new Date(clock - 16 * 60_000).toISOString(), new Date(clock + 60_000).toISOString()]) {
    const saved = { ...backup(), backupInterval: { endTime } };
    const f = fixture({ list: [saved], saved }); await assert.rejects(f.run(), /stage=verify-backup/);
    assert.ok(f.calls.every(({ init }) => init.method === "GET"));
  }
});
test("fresh completion cannot hide an old, missing, future or reversed start time", async () => {
  for (const startTime of [undefined, "PRIVATE_INVALID_TIME", new Date(clock - 16 * 60_000).toISOString(),
    new Date(clock + 60_000).toISOString(), new Date(clock + 1_000).toISOString()]) {
    const saved = { ...backup(), backupInterval: { startTime, endTime: new Date(clock).toISOString() } };
    const f = fixture({ list: [saved], saved });
    await assert.rejects(f.run(), (error) => /stage=verify-backup/.test(error.message) && !/PRIVATE/.test(error.message));
    assert.ok(f.calls.every(({ init }) => init.method === "GET"));
  }
});
test("new backup must start within 30 seconds of this request; retry can reuse a recent start", async () => {
  const saved = { ...backup(), backupInterval: { startTime: new Date(clock - 60_000).toISOString(), endTime: new Date(clock).toISOString() } };
  await assert.rejects(fixture({ saved }).run(), /stage=verify-backup/);
  await fixture({ list: [saved], saved }).run();
  await fixture({ saved: { ...saved, backupInterval: { ...saved.backupInterval, startTime: new Date(clock - 30_000).toISOString() } } }).run();
});
const otherBackup = (i, extra = {}) => ({ ...backup(), name: `projects/mfmf-499612/backups/other-${i}`, description: "other-marker", ...extra });
test("all on-demand markers count toward the eight-backup limit before a create", async () => {
  const f = fixture({ list: Array.from({ length: 8 }, (_, i) => otherBackup(i)) });
  await assert.rejects(f.run(), /stage=backup-capacity/);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].init.method, "GET");
  await fixture({ list: Array.from({ length: 7 }, (_, i) => otherBackup(i)) }).run();
});
test("existing marker can be reused at eight backups but not above the limit", async () => {
  await fixture({ list: [backup(), ...Array.from({ length: 7 }, (_, i) => otherBackup(i))] }).run();
  const f = fixture({ list: [backup(), ...Array.from({ length: 8 }, (_, i) => otherBackup(i))] });
  await assert.rejects(f.run(), /stage=backup-capacity/);
  assert.ok(f.calls.every(({ init }) => init.method === "GET"));
});
test("capacity unknown, invalid or already at one GiB prevents any create", async () => {
  for (const maxChargeableBytes of [undefined, null, 10, "-1", "1.5", "01", "PRIVATE_BYTES", "99999999999999999999", "1073741824"]) {
    const f = fixture({ list: [otherBackup(1, { maxChargeableBytes })] });
    await assert.rejects(f.run(), (error) => /stage=backup-capacity/.test(error.message) && !/PRIVATE/.test(error.message));
    assert.equal(f.calls.length, 1);
  }
});
test("capacity adds all on-demand bytes and rechecks the returned resource", async () => {
  const full = fixture({ list: [otherBackup(1, { maxChargeableBytes: "536870912" }), otherBackup(2, { maxChargeableBytes: "536870912" })] });
  await assert.rejects(full.run(), /stage=backup-capacity/); assert.equal(full.calls.length, 1);
  const created = fixture({ list: [otherBackup(1, { maxChargeableBytes: "1073741820" })] });
  await assert.rejects(created.run(), /stage=backup-capacity/); assert.equal(created.calls.length, 3);
  const reused = fixture({ list: [backup(), otherBackup(1, { maxChargeableBytes: "1073740824" })],
    saved: { ...backup(), maxChargeableBytes: "1001" } });
  await assert.rejects(reused.run(), /stage=backup-capacity/);
  assert.ok(reused.calls.every(({ init }) => init.method === "GET"));
});
test("automated and final backups do not consume the on-demand allowance and are never changed", async () => {
  const f = fixture({ list: Array.from({ length: 14 }, (_, i) => otherBackup(i, {
    type: i % 2 ? "AUTOMATED" : "FINAL", maxChargeableBytes: undefined,
  })) });
  await f.run(); assert.equal(f.calls.filter(({ init }) => init.method === "POST").length, 1);
  assert.ok(f.calls.every(({ init }) => ["GET", "POST"].includes(init.method)));
});
test("partial, duplicate or foreign inventory fails before creation", async () => {
  for (const list of [[otherBackup(1), otherBackup(1)], [otherBackup(1, { instance: "other" })],
    [otherBackup(1, { type: "PRIVATE_UNKNOWN" })], [null]]) {
    const f = fixture({ list }); await assert.rejects(f.run(), /stage=list-backups/); assert.equal(f.calls.length, 1);
  }
  for (const result of [{ backups: [], warnings: ["PRIVATE_WARNING"] }, { backups: [], nextPageToken: "repeated" }]) {
    const calls = [];
    await assert.rejects(ensurePreMigrationBackup({ env, accessToken: "PRIVATE_TOKEN", now: () => clock,
      fetchImpl: async (_url, init) => { calls.push(init); return Response.json(result); } }), /stage=list-backups/);
    assert.ok(calls.every(({ method }) => method === "GET"));
  }
});
test("capacity is accumulated across all pages before creating", async () => {
  let calls = 0;
  await assert.rejects(ensurePreMigrationBackup({ env, accessToken: "PRIVATE_TOKEN", now: () => clock,
    fetchImpl: async (url, init) => {
      assert.equal(init.method, "GET"); calls++;
      const offset = new URL(url).searchParams.has("pageToken") ? 4 : 0;
      return Response.json({ backups: Array.from({ length: 4 }, (_, i) => otherBackup(offset + i)),
        ...(offset ? {} : { nextPageToken: "next" }) });
    } }), /stage=backup-capacity/);
  assert.equal(calls, 2);
});
test("standard on-demand missing expiry still blocks SQL after a successful create", async () => {
  const f = fixture({ saved: { ...backup(), expiryTime: null, ttlDays: null } });
  await assert.rejects(f.run(), /stage=verify-backup/);
  assert.equal(f.calls.length, 3);
});
test("duplicate markers and pending prior backups stop without creating more", async () => {
  for (const list of [[backup(), backup()], [backup()]]) {
    const f = fixture({ list, saved: { ...backup(), state: "RUNNING" } }); await assert.rejects(f.run());
    assert.ok(f.calls.every(({ init }) => init.method === "GET"));
  }
});
test("never follows foreign operations or resource names", async () => {
  for (const change of [{ targetProject: "other" }, { targetId: "other" }, { name: "../other" }, { backupContext: { name: "projects/other/backups/private" } }]) {
    const f = fixture({ op: { ...operation(), ...change } }); await assert.rejects(f.run(), /stage=backup-operation/);
    assert.equal(f.calls.length, 2);
  }
});
test("fixed errors omit provider bodies and token values", async () => {
  const f = fixture({ failStatus: 400 });
  await assert.rejects(f.run(), (error) => /stage=list-backups http=400/.test(error.message) && !/PRIVATE/.test(error.message));
});
test("wrong operation or missing SHA makes no request", async () => {
  const f = fixture(); await assert.rejects(f.run({ env: { ...env, MFMF_DB_OPERATION: "import" } }));
  await assert.rejects(f.run({ env: { ...env, MFMF_DB_DEPLOY_SHA: "" } })); assert.equal(f.calls.length, 0);
});
