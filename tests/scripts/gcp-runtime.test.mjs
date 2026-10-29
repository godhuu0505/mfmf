import test from "node:test";
import assert from "node:assert/strict";
import { runtimePlan } from "../../scripts/gcp/runtime.mjs";

const valid = {
  GCP_AUTH_ENABLED: "true", NEXT_PUBLIC_GCP_AUTH_ENABLED: "true", GCP_PROJECT_ID: "mfmf-499612",
  GCP_AUTH_ORIGIN: "https://mfmf-candidate-wspqvmhj6q-an.a.run.app",
  MFMF_DATABASE_PASSWORD: "a".repeat(43), IDENTITY_PLATFORM_API_KEY: "b".repeat(39),
  GOOGLE_CLIENT_SECRET: "fixture-never-in-database-process", TOKEN_ENC_KEY: "fixture-app-only",
};
test("existing deployment starts only Next.js while the opt-in is disabled", () => {
  const plan = runtimePlan({ GOOGLE_CLIENT_SECRET: "fixture" }, () => { throw new Error("must not generate keys"); });
  assert.equal(plan.database, false); assert.deepEqual(plan.processes, []);
});
test("one-container data plane uses a private connector, loopback API and bounded pool", () => {
  const plan = runtimePlan(valid, () => Buffer.alloc(32, 7));
  assert.equal(plan.processes.length, 2);
  assert(plan.processes[0].args.includes("--private-ip"));
  assert(plan.processes[0].args.includes("--max-connections=4"));
  const config = plan.processes[1].env;
  assert.equal(config.PGRST_SERVER_HOST, "127.0.0.1");
  assert.equal(config.PGRST_DB_POOL, "2");
  assert.equal(config.PGRST_DB_CONFIG, "false");
  assert.equal(config.PGRST_JWT_SECRET, plan.nextEnv.MFMF_DATABASE_JWT_SECRET);
  assert.equal(config.PGRST_JWT_AUD, "mfmf-internal-database");
  assert.equal(config.PGRST_JWT_SECRET_IS_BASE64, "true");
  assert.equal(plan.nextEnv.MFMF_DATABASE_PASSWORD, undefined);
  const db = new URL(config.PGRST_DB_URI);
  assert.equal(db.username, "authenticator"); assert.equal(db.pathname, "/mfmf");
  assert.equal(db.searchParams.get("host"), "/tmp/mfmf-cloudsql/mfmf-499612:asia-northeast1:mfmf-db");
  for (const item of plan.processes) {
    assert(!JSON.stringify(item.env).includes("fixture-app-only"));
    assert(!JSON.stringify(item.env).includes("fixture-never-in-database-process"));
  }
});
test("each process group gets a fresh in-memory signing key", () => {
  assert.notEqual(runtimePlan(valid).nextEnv.MFMF_DATABASE_JWT_SECRET, runtimePlan(valid).nextEnv.MFMF_DATABASE_JWT_SECRET);
});
test("refuses mismatched flags, alternate projects/origins and preseeded JWT keys", () => {
  for (const patch of [
    { GCP_AUTH_ENABLED: "maybe" }, { NEXT_PUBLIC_GCP_AUTH_ENABLED: "false" },
    { GCP_PROJECT_ID: "another" }, { GCP_AUTH_ORIGIN: "https://example.test" },
    { MFMF_DATABASE_PASSWORD: "bad\nvalue" }, { IDENTITY_PLATFORM_API_KEY: "" },
    { MFMF_DATABASE_JWT_SECRET: "user-provided-value" },
  ]) assert.throws(() => runtimePlan({ ...valid, ...patch }), /values withheld/);
});
