import test from "node:test";
import assert from "node:assert/strict";
import { RETENTION, runDatabaseBackupRetention, verifyRetentionReadiness, retentionApi, retentionInventory } from "../../scripts/gcp/database-backup-retention.mjs";
import { API, META, CLOCK, SHA, backup, receipt, fixture } from "./helpers/database-retention-fixture.mjs";
const env = { CLOUD_RUN_JOB: RETENTION.job, CLOUD_RUN_TASK_COUNT: "1", CLOUD_RUN_TASK_INDEX: "0", CLOUD_RUN_TASK_ATTEMPT: "0", MFMF_BACKUP_DEPLOY_SHA: SHA };
const recent = () => backup("automated", 0.5, { type: "AUTOMATED", description: "" });
const old = () => backup("owned-old", 15);
const run = (f, extra = {}) => runDatabaseBackupRetention({ env, accessToken: "PRIVATE_TOKEN", fetchImpl: f.fetchImpl, now: () => CLOCK, wait: async () => {}, maxPolls: 2, ...extra });
const ready = (f) => verifyRetentionReadiness({ accessToken: "PRIVATE_TOKEN", fetchImpl: f.fetchImpl, now: () => CLOCK });
const writes = (f, method) => f.state.calls.filter(c => c.init.method === method);
const failure = async (f, pattern = /retention failed/) => {
  await assert.rejects(run(f), e => pattern.test(e.message) && !/PRIVATE/.test(e.message));
  assert.notEqual(f.state.proof?.status, "success");
};
test("empty cleanup writes generation-CAS proof after fresh automated recovery point validation", async () => {
  const f = await fixture({ rows: [recent()], proof: null });
  assert.deepEqual(await run(f), { status: "verified", policy: RETENTION.policy, listedCount: 1, deletedCount: 0, onDemandCount: 0, onDemandBytes: "0", receiptVerified: true });
  assert.deepEqual(f.state.writes.map(r => r.status), ["running", "success"]); assert.equal(writes(f, "DELETE").length, 0);
  assert.equal((await ready(f)).generation, f.state.generation);
});
test("only owned backups older than 14 days are deleted once and absent before success", async () => {
  const protectedRows = [recent(), backup("foreign-marker", 30, { description: "migration-checkpoint" }), backup("final", 30, { type: "FINAL" }), backup("unowned", 30, { description: "mfmf-managed-preupgrade-v1:PRIVATE" })];
  const f = await fixture({ rows: [old(), ...protectedRows] });
  const result = await run(f); assert.equal(result.deletedCount, 1); assert.deepEqual(f.state.deleted, [old().name]);
  for (const row of protectedRows) assert.ok(f.state.rows.has(row.name));
  assert.equal(f.state.proof.status, "success"); assert.ok(f.state.calls.every(c => c.init.redirect === "error"));
});
test("14-day boundary checks both start and end; young completion is retained", async () => {
  for (const age of [14 - 1 / 86400, 14]) {
    const f = await fixture({ rows: [recent(), backup("age", age)] });
    await run(f); assert.equal(f.state.deleted.length, age === 14 ? 1 : 0);
  }
  const f = await fixture({ rows: [recent(), backup("long", 20, { backupInterval: { startTime: old().backupInterval.startTime, endTime: new Date(CLOCK - 86400000).toISOString() } })] });
  await run(f); assert.equal(f.state.deleted.length, 0);
});
test("missing or older than 48-hour recovery point prevents deleting even very old owned backups", async () => {
  for (const rows of [[old()], [old(), backup("stale", 2.01, { type: "AUTOMATED" })], []]) {
    const f = await fixture({ rows }); await failure(f, /newer/); assert.equal(writes(f, "DELETE").length, 0);
  }
});
test("newer point with foreign region, bad times, near expiry, or pre-instance birth is unusable", async () => {
  for (const change of [{ location: "us" }, { expiryTime: new Date(CLOCK + 60000).toISOString() },
    { backupInterval: { startTime: "2025-01-01T00:00:00Z", endTime: new Date(CLOCK).toISOString() } },
    { backupInterval: { startTime: new Date(CLOCK + 1000).toISOString(), endTime: new Date(CLOCK).toISOString() } }]) {
    const f = await fixture({ rows: [old(), { ...recent(), ...change }] }); await failure(f); assert.equal(f.state.deleted.length, 0);
  }
});
test("all detailed ON_DEMAND bytes including unrelated markers count before any deletion", async () => {
  for (const rows of [Array.from({ length: 9 }, (_, i) => backup(`old-${i}`, 20)), [old(), backup("large", 0, { maxChargeableBytes: "1073741824" })],
    [old(), backup("unknown", 0, { maxChargeableBytes: undefined })]]) {
    const f = await fixture({ rows: [...rows, recent()] }); await failure(f, /capacity/); assert.equal(f.state.deleted.length, 0);
  }
});
test("incomplete, foreign, cyclic or duplicate listing cannot publish a valid receipt", async () => {
  for (const payload of [{ warnings: ["PRIVATE"], backups: [] }, { backups: [old(), old()] },
    { backups: [backup("foreign", 0, { instance: "other" })] }, { backups: [], nextPageToken: "same" }]) {
    const f = await fixture({ rows: [recent()], hook: url => url.startsWith(`${API}/backups?`) ? Response.json(payload) : undefined });
    await failure(f, /list/); assert.equal(f.state.deleted.length, 0);
  }
});
test("list detail identity mismatch or disappeared object fails closed", async () => {
  for (const response of [Response.json({ ...old(), name: "projects/mfmf-499612/backups/other" }), new Response(null, { status: 404 })]) {
    const f = await fixture({ rows: [old(), recent()], hook: url => url.endsWith("/backups/owned-old") ? response.clone() : undefined });
    await failure(f); assert.equal(f.state.deleted.length, 0);
  }
});
test("current instance birth/settings drift blocks delete", async () => {
  for (const change of [s => { s.resource.createTime = "2026-01-02T00:00:00Z"; }, s => { s.resource.settings.settingsVersion = "2"; }]) {
    let reads = 0;
    const f = await fixture({ rows: [old(), recent()], hook: (url, _init, state) => { if (url === `${API}/instances/mfmf-db` && ++reads === 2) change(state); } });
    await failure(f, /drift/); assert.equal(f.state.deleted.length, 0);
  }
});
test("active SQL operation blocks cleanup before receipt or deletes", async () => {
  const f = await fixture({ rows: [old(), recent()], hook: url => url.startsWith(`${API}/operations?`) ? Response.json({ items: [{ targetProject: "mfmf-499612", targetId: "mfmf-db", status: "RUNNING" }] }) : undefined });
  await assert.rejects(run(f), /operations/); assert.equal(f.state.writes.length, 0); assert.equal(f.state.deleted.length, 0);
});
test("old or newer resource drift during individual pre-delete recheck prevents delete", async () => {
  for (const id of ["owned-old", "automated"]) {
    let reads = 0;
    const f = await fixture({ rows: [old(), recent()], hook: (url, init, state) => {
      if (url.endsWith(`/backups/${id}`) && init.method === "GET" && ++reads === 3) return Response.json({ ...state.rows.get(`projects/mfmf-499612/backups/${id}`), maxChargeableBytes: "1001" });
    } });
    await failure(f, /drift/); assert.equal(f.state.deleted.length, 0);
  }
});
test("concurrent receipt generation change blocks delete and cannot be overwritten", async () => {
  let reads = 0;
  const f = await fixture({ rows: [old(), recent()], hook: (url, _init, state) => {
    if (url === META && ++reads === 3) { state.generation = "777"; state.proof = { status: "running" }; }
  } });
  await failure(f, /drift/); assert.equal(f.state.deleted.length, 0); assert.equal(f.state.generation, "777");
});
test("existing running receipt requires explicit reconciliation, never automatic takeover", async () => {
  const f = await fixture({ rows: [old(), recent()], proof: await receipt({ status: "running", startedAt: "2025-01-01T00:00:00Z" }) });
  await assert.rejects(run(f), /readiness/); assert.equal(f.state.writes.length, 0); assert.equal(f.state.deleted.length, 0);
});
test("initial CAS conflict performs no SQL deletion", async () => {
  const f = await fixture({ rows: [old(), recent()], hook: url => url.includes("/upload/") ? new Response("PRIVATE", { status: 412 }) : undefined });
  await assert.rejects(run(f), e => /receipt-write http=412/.test(e.message) && !/PRIVATE/.test(e.message)); assert.equal(f.state.deleted.length, 0);
});
test("delete response loss or HTTP failure is not retried and fails receipt", async () => {
  for (const shouldThrow of [true, false]) {
    const f = await fixture({ rows: [old(), recent()], hook: (_url, init) => {
      if (init.method === "DELETE") { if (shouldThrow) throw new Error("PRIVATE"); return new Response("PRIVATE", { status: 500 }); }
    } });
    await failure(f, /delete/); assert.equal(writes(f, "DELETE").length, 1);
  }
});
test("wrong operation identity/type/error/timeout stops and never resends delete", async () => {
  for (const operation of [{ targetProject: "other" }, { targetId: "other" }, { name: "../other" }, { operationType: "RESTORE_VOLUME" },
    { error: { message: "PRIVATE" } }, { status: "RUNNING" }]) {
    const f = await fixture({ rows: [old(), recent()], operation });
    await failure(f, /poll|timeout/); assert.equal(writes(f, "DELETE").length, 1);
  }
});
test("operation DONE without resource absence cannot report success", async () => {
  const f = await fixture({ rows: [old(), recent()], hook: (url, init, state) => {
    if (url.endsWith("/backups/owned-old") && init.method === "GET" && state.deleted.length) return Response.json(old());
  } });
  await failure(f, /absence/); assert.equal(writes(f, "DELETE").length, 1);
});
test("a new eligible backup appearing after plan is not silently ignored", async () => {
  let lists = 0;
  const f = await fixture({ rows: [recent()], hook: (url, _init, state) => { if (url.startsWith(`${API}/backups?`) && ++lists === 2) state.rows.set(old().name, old()); } });
  await failure(f, /drift/); assert.equal(f.state.deleted.length, 0);
});
test("final receipt write failure cannot return success even after verified deletion", async () => {
  const f = await fixture({ rows: [old(), recent()], hook: (url, init) => {
    if (url.includes("/upload/") && JSON.parse(init.body).status === "success") return new Response("PRIVATE", { status: 503 });
  } });
  await failure(f, /receipt-write/); assert.equal(f.state.deleted.length, 1);
});
test("receipt readback body differs from uploaded object fails before deleting", async () => {
  const f = await fixture({ rows: [old(), recent()], hook: (url, _init, state) => {
    if (url.startsWith(`${META}?`) && state.proof?.status === "running") return Response.json({ ...state.proof, extra: "PRIVATE" });
  } });
  await assert.rejects(run(f), /receipt-verify/); assert.equal(f.state.deleted.length, 0);
});
test("full pagination hydration includes every detailed resource", async () => {
  const a = old(), b = recent();
  const f = await fixture({ rows: [a, b], hook: url => {
    if (!url.startsWith(`${API}/backups?`)) return;
    const second = new URL(url).searchParams.has("pageToken"); const r = second ? b : a;
    return Response.json({ backups: [{ name: r.name, instance: r.instance, type: r.type }], ...(second ? {} : { nextPageToken: "second" }) });
  } });
  const rows = await retentionInventory(retentionApi({ accessToken: "PRIVATE_TOKEN", fetchImpl: f.fetchImpl }));
  assert.equal(rows.length, 2); assert.equal(rows[0].maxChargeableBytes, "1000");
});
test("context rejects wrong job, automatic retries, extra tasks, or invalid SHA without network", async () => {
  for (const change of [{ CLOUD_RUN_JOB: "other" }, { CLOUD_RUN_TASK_COUNT: "2" }, { CLOUD_RUN_TASK_INDEX: "1" }, { CLOUD_RUN_TASK_ATTEMPT: "1" }, { MFMF_BACKUP_DEPLOY_SHA: "PRIVATE" }]) {
    const f = await fixture(); await assert.rejects(run(f, { env: { ...env, ...change } }), /context/); assert.equal(f.state.calls.length, 0);
  }
});
test("bounded HTTP diagnostics suppress body, invalid JSON, huge responses, and token", async () => {
  for (const response of [new Response("PRIVATE", { status: 403 }), new Response("PRIVATE"), new Response("X".repeat(1048577))]) {
    const api = retentionApi({ accessToken: "PRIVATE_TOKEN", fetchImpl: async () => response });
    await assert.rejects(api(`${API}/backups`, "list"), e => /stage=list/.test(e.message) && !/PRIVATE/.test(e.message));
  }
});

test("post-delete 403 requires successful owned operation, full absence and same-token pinned newer readback", async () => {
  const f = await fixture({ rows: [old(), recent()], hook: (url, init, state) => {
    if (url.endsWith("/backups/owned-old") && init.method === "GET" && state.deleted.length) return new Response("PRIVATE_PERMISSION_BODY", { status: 403 });
  } });
  const result = await run(f); assert.equal(result.deletedCount, 1); assert.equal(f.state.proof.status, "success");
  assert.equal(writes(f, "DELETE").length, 1);
  const deletion = f.state.calls.findIndex(c => c.init.method === "DELETE");
  const after = f.state.calls.slice(deletion + 1);
  assert.ok(after.some(c => c.url.startsWith(`${API}/backups?`)));
  assert.ok(after.filter(c => c.url.endsWith("/backups/automated")).length >= 2);
  assert.ok(after.every(c => c.init.headers.Authorization === "Bearer PRIVATE_TOKEN"));
});
test("post-delete 403 cannot pass when list/individual GET/newer/instance permissions fail", async () => {
  for (const failureAt of ["list", "newer", "instance"]) {
    const f = await fixture({ rows: [old(), recent()], hook: (url, init, state) => {
      if (!state.deleted.length || init.method !== "GET") return;
      if (url.endsWith("/backups/owned-old") || failureAt === "list" && url.startsWith(`${API}/backups?`)
        || failureAt === "newer" && url.endsWith("/backups/automated") || failureAt === "instance" && url.endsWith("/instances/mfmf-db")) return new Response("PRIVATE", { status: 403 });
    } });
    await failure(f); assert.equal(writes(f, "DELETE").length, 1);
  }
});
test("post-delete 403 cannot pass incomplete listing, retained target, or missing newer", async () => {
  for (const mode of ["partial", "target", "no-newer"]) {
    const f = await fixture({ rows: [old(), recent()], hook: (url, init, state) => {
      if (!state.deleted.length || init.method !== "GET") return;
      if (url.endsWith("/backups/owned-old")) return new Response("PRIVATE", { status: 403 });
      if (url.startsWith(`${API}/backups?`)) {
        if (mode === "partial") return Response.json({ backups: [], warnings: ["PRIVATE"] });
        if (mode === "no-newer") return Response.json({ backups: [] });
        return Response.json({ backups: [old(), recent()] });
      }
    } });
    await failure(f); assert.equal(writes(f, "DELETE").length, 1);
  }
});
test("post-delete 403 cannot pass newer identity or instance birth/config drift", async () => {
  for (const mode of ["newer", "birth", "settings"]) {
    const f = await fixture({ rows: [old(), recent()], hook: (url, init, state) => {
      if (!state.deleted.length || init.method !== "GET") return;
      if (url.endsWith("/backups/owned-old")) return new Response("PRIVATE", { status: 403 });
      if (mode === "newer" && url.endsWith("/backups/automated")) return Response.json({ ...recent(), maxChargeableBytes: "1001" });
      if (url.endsWith("/instances/mfmf-db")) {
        const resource = structuredClone(state.resource);
        if (mode === "birth") resource.createTime = "2026-01-02T00:00:00Z";
        if (mode === "settings") resource.settings.settingsVersion = "2";
        return Response.json(resource);
      }
    } });
    await failure(f); assert.equal(writes(f, "DELETE").length, 1);
  }
});
test("403 before DELETE, from DELETE, or after a failed operation never enters absence fallback", async () => {
  for (const mode of ["before", "delete", "operation"]) {
    const f = await fixture({ rows: [old(), recent()], operation: mode === "operation" ? { error: { message: "PRIVATE" } } : {},
      hook: (url, init) => {
        if (mode === "before" && url.endsWith("/backups/owned-old") && init.method === "GET"
          || mode === "delete" && init.method === "DELETE") return new Response("PRIVATE", { status: 403 });
      } });
    await failure(f); assert.equal(writes(f, "DELETE").length, mode === "before" ? 0 : 1);
  }
});
test("post-delete 401/429/500 or network failure never use the narrow 403 fallback", async () => {
  for (const status of [401, 429, 500, null]) {
    const f = await fixture({ rows: [old(), recent()], hook: (url, init, state) => {
      if (url.endsWith("/backups/owned-old") && init.method === "GET" && state.deleted.length) {
        if (status === null) throw new Error("PRIVATE");
        return new Response("PRIVATE", { status });
      }
    } });
    await failure(f, /absence/); assert.equal(writes(f, "DELETE").length, 1);
  }
});
test("404 also requires the pinned newer recovery point to remain readable", async () => {
  const f = await fixture({ rows: [old(), recent()], hook: (url, init, state) => {
    if (state.deleted.length && init.method === "GET" && url.endsWith("/backups/automated")) return new Response("PRIVATE", { status: 403 });
  } });
  await failure(f); assert.equal(writes(f, "DELETE").length, 1);
});
