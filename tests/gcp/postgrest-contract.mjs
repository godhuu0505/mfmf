// Synthetic integration entry point, bundled by postgrest-proof.mjs and executed
// only inside its network-disabled, randomly named PostgreSQL fixture container.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { runtimePlan } from "../../scripts/gcp/runtime.mjs";
import { createGcpDataClient } from "../../src/lib/gcp/dataClient.ts";

const BASE = "http://127.0.0.1:3001";
const UUID_A = "91000000-0000-4000-8000-000000000001";
const UUID_B = "91000000-0000-4000-8000-000000000002";
const HH_A = "92000000-0000-4000-8000-000000000001";
const RECORD_A = "93000000-0000-4000-8000-000000000001";
const RECORD_B = "93000000-0000-4000-8000-000000000002";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let lastCheck = "startup";

async function main() {
  const plan = runtimePlan({ GCP_AUTH_ENABLED: "true", NEXT_PUBLIC_GCP_AUTH_ENABLED: "true", GCP_PROJECT_ID: "mfmf-499612",
    GCP_AUTH_ORIGIN: "https://mfmf-candidate-wspqvmhj6q-an.a.run.app", MFMF_DATABASE_PASSWORD: "synthetic-not-production-password-1234",
    IDENTITY_PLATFORM_API_KEY: "synthetic-api-key-never-used" });
  assert.equal(plan.database, true);
  assert.equal(plan.nextEnv.MFMF_DATABASE_PASSWORD, undefined);
  const api = plan.processes.find((item) => item.stage === "database-api");
  assert.equal(api.env.PGRST_SERVER_HOST, "127.0.0.1");
  assert.equal(api.env.PGRST_DB_POOL, "2");
  // Unix-socket trust belongs only to this isolated synthetic fixture. Every
  // other PostgREST setting, including authenticator, JWT and pool, is runtime's.
  const child = spawn(api.executable, api.args, { env: { ...api.env,
    PGRST_DB_URI: "postgresql://authenticator@/mfmf?host=/var/run/postgresql" }, stdio: "ignore" });
  let childError = false; child.on("error", () => { childError = true; });
  const key = plan.nextEnv.MFMF_DATABASE_JWT_SECRET;
  const jwt = (overrides = {}, secret = key, algorithm = "HS256") => {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: algorithm, typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ iss: "mfmf-server", aud: "mfmf-internal-database", role: "authenticated", sub: UUID_A, iat: now, exp: now + 60, ...overrides })).toString("base64url");
    const message = `${header}.${payload}`;
    return `${message}.${algorithm === "none" ? "" : createHmac("sha256", Buffer.from(secret, "base64")).update(message).digest("base64url")}`;
  };
  const raw = (path, token) => fetch(BASE + path, { redirect: "error", signal: AbortSignal.timeout(10_000), ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}) });
  let assertions = 0;
  const checked = (condition, message) => { lastCheck = message; assert.ok(condition, message); assertions++; };
  const seen = [];
  const observeFetch = async (input, init) => {
    const url = new URL(String(input)); assert.equal(url.origin, BASE);
    const headers = new Headers(init?.headers); const token = headers.get("authorization");
    const claims = JSON.parse(Buffer.from(token.slice(7).split(".")[1], "base64url").toString());
    seen.push({ role: claims.role, sub: claims.sub, lifetime: claims.exp - claims.iat });
    assert.equal(headers.has("apikey"), false); assert.equal(headers.has("cookie"), false);
    return fetch(input, init);
  };
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (childError || child.exitCode !== null) throw new Error("Fixture PostgREST stopped before readiness.");
      try { const response = await fetch("http://127.0.0.1:3002/ready", { signal: AbortSignal.timeout(250) }); await response.body?.cancel(); ready = response.status === 200; } catch { /* startup only */ }
      if (ready) break; await delay(100);
    }
    checked(ready, "real PostgREST admin readiness");
    const sockets = (await readFile("/proc/net/tcp", "utf8")).split("\n").map((row) => row.trim().split(/\s+/));
    for (const port of ["0BB9", "0BBA"]) {
      const listening = sockets.filter((row) => row[1]?.endsWith(`:${port}`) && row[3] === "0A");
      checked(listening.length === 1 && listening[0][1] === `0100007F:${port}`, "API and admin bind loopback only");
    }
    process.env.SIGNUP_ENABLED = "false";
    const options = { secret: key, fetchImpl: observeFetch };
    const anonymous = await createGcpDataClient(null, options);
    const backend = await anonymous.client.rpc("get_media_read_backend");
    checked(!backend.error && backend.data === "gcs", "anonymous backend RPC uses current GCS mode");
    checked(anonymous.user === null, "anonymous client has no user");
    const deniedRead = await anonymous.client.from("daycare_records").select("id");
    checked(deniedRead.error !== null && deniedRead.data === null, "anonymous cannot read private records");
    const identities = [
      { subject: "postgrest-user-a", email: "a@example.test", emailVerified: true },
      { subject: "postgrest-user-b", email: "b@example.test", emailVerified: true },
    ];
    const [a, b] = await Promise.all(identities.map((identity) => createGcpDataClient(identity, options)));
    checked(a.user.id === UUID_A && b.user.id === UUID_B, "existing subject mapping preserves internal UUIDs");
    for (let index = 0; index < 2; index++) {
      await assert.rejects(createGcpDataClient({ subject: "previously-created-provider-account", email: "new@example.test", emailVerified: true }, options), /synchronization failed/);
      assertions++;
    }
    process.env.SIGNUP_ENABLED = "true";
    const newlyAdmitted = await createGcpDataClient({ subject: "explicitly-open-registration", email: "a@example.test", emailVerified: true }, options);
    checked(/^[0-9a-f-]{36}$/.test(newlyAdmitted.user.id) && ![UUID_A, UUID_B].includes(newlyAdmitted.user.id), "explicit open registration creates a distinct UUID without email linking");
    process.env.SIGNUP_ENABLED = "false";
    const returned = await createGcpDataClient({ subject: "explicitly-open-registration", email: "a@example.test", emailVerified: true }, options);
    checked(returned.user.id === newlyAdmitted.user.id, "admitted subject remains stable after registration closes");
    const query = async (client, expectedId) => {
      const response = await client.from("daycare_records").select("id,owner_id,body");
      checked(response.error === null && response.data.length === 1 && response.data[0].id === expectedId, "per-user row isolation");
    };
    await query(a.client, RECORD_A); await query(b.client, RECORD_B);
    const pids = new Set();
    await Promise.all(Array.from({ length: 40 }, async (_, index) => {
      const selected = index % 2 ? a : b; const uid = index % 2 ? UUID_A : UUID_B;
      const result = await selected.client.rpc("proof_claims");
      checked(!result.error && result.data.uid === uid && result.data.role === "authenticated" && result.data.timeout === "8s", "concurrent claims and statement timeout");
      pids.add(result.data.pid); await query(selected.client, index % 2 ? RECORD_A : RECORD_B);
    }));
    checked(pids.size > 0 && pids.size <= 2, "runtime pool never exceeds two query connections");
    const forged = await a.client.from("daycare_records").insert({ owner_id: UUID_B, household_id: HH_A, body: "synthetic rejected" });
    checked(forged.error?.code === "42501", "forged other-owner insert rejected by actual RLS");
    const crossUpdate = await a.client.from("daycare_records").update({ body: "must-not-change" }).eq("id", RECORD_B).select("id");
    checked(!crossUpdate.error && crossUpdate.data.length === 0, "cross-household update affects no row");
    const ownUpdate = await a.client.from("daycare_records").update({ body: "synthetic own update" }).eq("id", RECORD_A).select("id");
    checked(!ownUpdate.error && ownUpdate.data.length === 1, "own authorized update works");
    const identityEscalation = await a.client.rpc("sync_identity", { p_subject: "attempted", p_email: "attempted@example.test", p_email_verified: true, p_allow_create: true });
    checked(identityEscalation.error !== null, "authenticated role cannot invoke sync_identity");
    const operatorEscalation = await a.client.rpc("set_media_storage_mode", { p_mode: "frozen" });
    checked(operatorEscalation.error !== null, "authenticated role cannot act as media operator");
    const slow = await a.client.rpc("proof_slow");
    checked(slow.error?.code === "57014", "real API obeys the eight-second SQL timeout");
    for (let index = 0; index < 8; index++) {
      const result = await anonymous.client.rpc("proof_claims");
      checked(!result.error && result.data.uid === null && result.data.role === "anon", "pooled claims clear after successful and failed transactions");
    }
    for (const token of [jwt({}, Buffer.alloc(32, 3).toString("base64")), jwt({ aud: "wrong" }), jwt({ exp: Math.floor(Date.now() / 1000) - 120 }), jwt({}, key, "none")]) {
      const response = await raw("/daycare_records?select=id", token); await response.body?.cancel(); checked(response.status === 401, "bad signature/audience/expiry/algorithm is rejected");
    }
    const ownerToken = await raw("/daycare_records?select=id", jwt({ role: "mfmf_owner" })); await ownerToken.body?.cancel();
    checked(ownerToken.status === 403, "authenticator cannot SET ROLE owner even with a correctly signed JWT");
    const invalidClaims = await raw("/rpc/proof_claims", jwt({ sub: "not-a-uuid" }));
    const invalidData = await invalidClaims.json(); checked(invalidClaims.status === 400 && invalidData.code === "22P02", "invalid UUID cannot authorize an identity");
    const noJwt = await raw("/rpc/proof_claims"); const noJwtData = await noJwt.json();
    checked(noJwt.status === 200 && noJwtData.uid === null && noJwtData.role === "anon", "request without JWT returns to anonymous role");
    checked(seen.every((item) => item.lifetime === 60), "data client issues only sixty-second JWTs");
    checked(seen.filter((item) => item.role === "identity_sync").every((item) => item.sub === undefined), "identity sync never carries an arbitrary authenticated subject");
    checked(!seen.some((item) => !["identity_sync", "authenticated", "anon"].includes(item.role)), "data client uses only allowed roles");
    // Prove normal application work still succeeds after timeout and all rejected JWTs.
    await query(b.client, RECORD_B); await query(a.client, RECORD_A);
    console.log(JSON.stringify({ postgrest: "16.5", assertions, concurrentRequests: 40, queryPoolConnections: pids.size,
      privateLoopback: true, runtimePlanUsed: true, actualDataClientUsed: true, rlsIsolation: true, claimsReset: true,
      productionResourcesTouched: false }));
  } finally {
    if (child.exitCode === null) { child.kill("SIGTERM"); await Promise.race([once(child, "exit"), delay(3000)]); if (child.exitCode === null) child.kill("SIGKILL"); }
  }
}
main().catch((error) => { console.error(JSON.stringify({ contractFailure: lastCheck, kind: error instanceof assert.AssertionError ? "assertion" : "execution" })); process.exitCode = 1; });
