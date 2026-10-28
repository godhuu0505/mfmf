import test from "node:test";
import assert from "node:assert/strict";
import { ensurePreMigrationBackup } from "../../scripts/gcp/database-prebackup.mjs";
const sha = "a".repeat(40);
const env = { CLOUD_RUN_JOB: "mfmf-db-operator", MFMF_DB_OPERATION: "upgrade", MFMF_DB_DEPLOY_SHA: sha };
const clock = Date.parse("2026-10-28T00:00:00Z");
const name = "projects/mfmf-499612/backups/fixture-backup";
const backup = () => ({ name, instance: "mfmf-db", description: `mfmf-managed-preupgrade-v1:${sha}`,
  type: "ON_DEMAND", state: "SUCCESSFUL", location: "asia-northeast1", expiryTime: new Date(clock + 14 * 86400000).toISOString(),
  backupInterval: { startTime: new Date(clock - 60_000).toISOString(), endTime: new Date(clock).toISOString() } });
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
