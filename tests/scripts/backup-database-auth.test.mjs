import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ARCHIVE_NAME, CA_SHA256, CA_URL, DUMP_ARGS, POOLER_URL, PROBE_SQL, SOURCE_REF,
  diagnostic, runBackup, selectPooler, validateContext } from "../../scripts/gcp/backup-database-auth.mjs";

// Public Supabase Root 2021 CA fixture, not a private key or project credential.
const CA = `-----BEGIN CERTIFICATE-----
MIIDxDCCAqygAwIBAgIUbLxMod62P2ktCiAkxnKJwtE9VPYwDQYJKoZIhvcNAQEL
BQAwazELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5l
dyBDYXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJh
c2UgUm9vdCAyMDIxIENBMB4XDTIxMDQyODEwNTY1M1oXDTMxMDQyNjEwNTY1M1ow
azELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5ldyBD
YXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJhc2Ug
Um9vdCAyMDIxIENBMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqQXW
QyHOB+qR2GJobCq/CBmQ40G0oDmCC3mzVnn8sv4XNeWtE5XcEL0uVih7Jo4Dkx1Q
DmGHBH1zDfgs2qXiLb6xpw/CKQPypZW1JssOTMIfQppNQ87K75Ya0p25Y3ePS2t2
GtvHxNjUV6kjOZjEn2yWEcBdpOVCUYBVFBNMB4YBHkNRDa/+S4uywAoaTWnCJLUi
cvTlHmMw6xSQQn1UfRQHk50DMCEJ7Cy1RxrZJrkXXRP3LqQL2ijJ6F4yMfh+Gyb4
O4XajoVj/+R4GwywKYrrS8PrSNtwxr5StlQO8zIQUSMiq26wM8mgELFlS/32Uclt
NaQ1xBRizkzpZct9DwIDAQABo2AwXjALBgNVHQ8EBAMCAQYwHQYDVR0OBBYEFKjX
uXY32CztkhImng4yJNUtaUYsMB8GA1UdIwQYMBaAFKjXuXY32CztkhImng4yJNUt
aUYsMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAB8spzNn+4VU
tVxbdMaX+39Z50sc7uATmus16jmmHjhIHz+l/9GlJ5KqAMOx26mPZgfzG7oneL2b
VW+WgYUkTT3XEPFWnTp2RJwQao8/tYPXWEJDc0WVQHrpmnWOFKU/d3MqBgBm5y+6
jB81TU/RG2rVerPDWP+1MMcNNy0491CTL5XQZ7JfDJJ9CCmXSdtTl4uUQnSuv/Qx
Cea13BX2ZgJc7Au30vihLhub52De4P/4gonKsNHYdbWjg7OWKwNv/zitGDVDB9Y2
CMTyZKG3XEu5Ghl1LEnI3QmEKsqaCLv12BnVjbkSeZsMnevJPs1Ye6TjjJwdik5P
o/bKiIz+Fq8=
-----END CERTIFICATE-----
`;
const PRIVATE = "PRIVATE_FIXTURE_CANNOT_LOG";
const ROW = { database_type: "PRIMARY", db_host: "aws-0-ap-northeast-1.pooler.supabase.com",
  db_user: `postgres.${SOURCE_REF}`, db_port: 6543, db_name: "postgres", pool_mode: "transaction",
  connection_string: PRIVATE };
const baseEnv = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "godhuu0505/mfmf", GITHUB_REF: "refs/heads/main",
  GITHUB_EVENT_NAME: "workflow_dispatch", SUPABASE_PROJECT_ID: SOURCE_REF,
  GITHUB_WORKFLOW_REF: "godhuu0505/mfmf/.github/workflows/backup-database-auth.yml@refs/heads/main",
  SUPABASE_ACCESS_TOKEN: `${PRIVATE}_PAT`, SUPABASE_DB_PASSWORD: `${PRIVATE}_PASSWORD`,
  SUPABASE_BACKUP_AGE_RECIPIENT: `age1${"a".repeat(58)}`, UNRELATED_SECRET: PRIVATE,
  PGHOST: "evil.example", PGOPTIONS: "-c default_transaction_read_only=off" };

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "mfmf-auth-backup-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const requests = [];
  let ageCalls = 0;
  const deps = {
    env: { ...baseEnv, RUNNER_TEMP: root },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      assert.equal(options.redirect, "error");
      if (url === POOLER_URL) return new Response(JSON.stringify([ROW]));
      assert.equal(url, CA_URL);
      assert.equal(options.headers, undefined, "PAT must not reach the public CA host");
      return new Response(CA);
    },
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options });
      assert.equal(options.shell, false);
      assert.equal(options.stdio[2], "ignore");
      assert.equal(options.env.UNRELATED_SECRET, undefined);
      assert.equal(options.env.SUPABASE_ACCESS_TOKEN, undefined);
      assert.equal(JSON.stringify(args).includes(PRIVATE), false);
      let source;
      if (args[0] === "--version") {
        source = `console.log(${JSON.stringify(`${command.endsWith("pg_dump") ? "pg_dump" : "psql"} (PostgreSQL) ${overrides.clientMajor ?? 17}.11 (fixture)`)});`;
        assert.equal(options.env.PGPASSWORD, undefined);
      } else if (command.endsWith("psql")) {
        assert.equal(args.at(-1), PROBE_SQL);
        source = `console.log(${JSON.stringify(overrides.probe ?? "170011|t|t|t|t|t")});`;
      } else if (command.endsWith("pg_dump")) {
        assert.deepEqual(args, DUMP_ARGS);
        source = overrides.dumpCode ?? `process.stdout.write('PGDMP${PRIVATE}'); process.stderr.write('${PRIVATE}'); process.exitCode=${overrides.dumpExit ?? 0};`;
      } else {
        assert.equal(command, "/usr/bin/age");
        assert.equal(options.env.PGPASSWORD, undefined);
        ageCalls++;
        const failure = ageCalls === 1 ? overrides.recipientExit : overrides.ageExit;
        source = `const chunks=[]; for await(const c of process.stdin) chunks.push(c);
          process.stderr.write('${PRIVATE}'); process.stdout.write('age-encryption.org/v1\\n-> fixture\\n'+Buffer.concat(chunks).toString('base64')); process.exitCode=${failure ?? 0};`;
        if (ageCalls === 2 && overrides.ageCode) source = overrides.ageCode;
      }
      if (options.env.PGPASSWORD) {
        assert.equal(options.env.PGPASSWORD, baseEnv.SUPABASE_DB_PASSWORD);
        assert.equal(options.env.PGHOST, ROW.db_host);
        assert.equal(options.env.PGPORT, "5432");
        assert.equal(options.env.PGSSLMODE, "verify-full");
        assert.match(options.env.PGOPTIONS, /default_transaction_read_only=on/);
      }
      return spawn(process.execPath, ["--input-type=module", "-e", source], options);
    },
  };
  return { root, calls, requests, deps, run: (extra = {}) => runBackup({ ...deps, ...extra }) };
}

async function failsClean(f, extra = {}, stage) {
  await assert.rejects(f.run(extra), (error) => {
    assert.equal(JSON.stringify(diagnostic(error)).includes(PRIVATE), false);
    if (stage) assert.equal(diagnostic(error).stage, stage);
    return true;
  });
  assert.deepEqual(await readdir(f.root), []);
}

test("public CA fixture matches pinned digest", () => {
  assert.equal(createHash("sha256").update(CA).digest("hex"), CA_SHA256);
});
test("single dump through isolated age subprocess publishes only private ciphertext", async (t) => {
  const f = await fixture(t);
  const result = await f.run();
  assert.equal(result.status, "encrypted");
  assert.equal(result.restore, "not-verified");
  assert.equal(JSON.stringify(result).includes(PRIVATE), false);
  assert.equal(f.calls.filter((c) => c.command.endsWith("pg_dump") && c.args[0] !== "--version").length, 1);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(await readdir(f.root), ["database-auth-backup-encrypted"]);
  const path = join(f.root, "database-auth-backup-encrypted", ARCHIVE_NAME);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(f.root, "database-auth-backup-encrypted"))).mode & 0o777, 0o700);
  assert.equal((await readFile(path, "utf8")).includes(PRIVATE), false);
});
test("wrong workflow/ref/repo/event/project and malformed credentials fail before any IO", async (t) => {
  const f = await fixture(t);
  for (const patch of [{ GITHUB_REF: "refs/heads/test" }, { GITHUB_REPOSITORY: "evil/repo" },
    { GITHUB_EVENT_NAME: "push" }, { SUPABASE_PROJECT_ID: "wrong" }, { GITHUB_WORKFLOW_REF: "wrong" },
    { SUPABASE_DB_PASSWORD: "bad\nvalue" }, { SUPABASE_ACCESS_TOKEN: "" }, { SUPABASE_BACKUP_AGE_RECIPIENT: PRIVATE }]) {
    assert.throws(() => validateContext({ ...f.deps.env, ...patch }));
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.requests.length, 0);
});
test("pooler rejects foreign host/role/database/port and ambiguous primary", () => {
  for (const patch of [{ db_host: "evil.example" }, { db_host: `${ROW.db_host}.evil.example` },
    { db_user: "postgres.other" }, { db_name: "other" }, { db_port: 5432 }, { database_type: "READ_REPLICA" }]) {
    assert.throws(() => selectPooler([{ ...ROW, ...patch }]));
  }
  assert.throws(() => selectPooler([ROW, { ...ROW, db_host: "aws-1-ap-northeast-1.pooler.supabase.com" }]));
  assert.equal(selectPooler([{ ...ROW, pool_mode: "session", db_port: 5432 }]).port, "5432");
});
for (const [name, overrides, stage] of [
  ["client major mismatch", { clientMajor: 18 }, "client-version"],
  ["source newer than client", { probe: "180001|t|t|t|t|t" }, "source-version"],
  ["source missing RLS bypass", { probe: "170011|t|f|t|t|t" }, "source-version"],
  ["source transaction writable", { probe: "170011|f|t|t|t|t" }, "source-version"],
  ["unexpected source response", { probe: PRIVATE }, "source-version"],
  ["invalid age recipient", { recipientExit: 1 }, "recipient"],
  ["dump partial then nonzero", { dumpExit: 1 }, "dump-encrypt"],
  ["age partial then nonzero", { ageExit: 1 }, "dump-encrypt"],
]) test(`${name} never publishes`, async (t) => failsClean(await fixture(t, overrides), {}, stage));
test("invalid custom archive header and empty dump fail", async (t) => {
  for (const dumpCode of [`process.stdout.write('${PRIVATE}')`, "process.exit(0)"]) {
    await failsClean(await fixture(t, { dumpCode }));
  }
});
test("early age exit / broken pipe and bounded archive fail", async (t) => {
  await failsClean(await fixture(t, { ageCode: "process.exit(1)", dumpCode: "for(let i=0;i<100;i++) process.stdout.write('PGDMP'.repeat(4096));" }));
  await failsClean(await fixture(t), { maxArchiveBytes: 10 });
});
test("hanging child is killed at timeout and incomplete output removed", async (t) => {
  await failsClean(await fixture(t, { dumpCode: "process.stdout.write('PGDMP'); setInterval(()=>{},1000);" }), { timeoutMs: 500 });
});
test("nonzero dump immediately kills a hanging age peer", async (t) => {
  const f = await fixture(t, { dumpExit: 1, ageCode: "process.stdin.resume(); setInterval(()=>{},1000);" });
  const started = Date.now();
  await failsClean(f, { timeoutMs: 5000 });
  assert.ok(Date.now() - started < 3000, "failure should not wait for the overall timeout");
});
test("spawn error is sanitized and leaves no artifact", async (t) => {
  const f = await fixture(t);
  await failsClean(f, { spawnImpl: () => { throw new Error(PRIVATE); } }, "client-version");
});
test("HTTP error body is never read; only bounded status is reportable", async (t) => {
  const f = await fixture(t);
  let cancelled = false;
  await failsClean(f, { fetchImpl: async () => ({ status: 403, body: {
    cancel: async () => { cancelled = true; }, [Symbol.asyncIterator]: () => { throw new Error(PRIVATE); },
  } }) }, "pooler");
  assert.equal(cancelled, true);
});
test("metadata parse/size and CA mismatch/redirect errors cannot publish", async (t) => {
  for (const variant of ["malformed", "oversized", "bad-ca", "network"]) {
    const f = await fixture(t);
    await failsClean(f, { fetchImpl: async (url, options) => {
      assert.equal(options.redirect, "error");
      if (variant === "network") throw new Error(PRIVATE);
      if (url === CA_URL) return new Response(PRIVATE);
      return new Response(variant === "malformed" ? PRIVATE : variant === "oversized" ? "x".repeat(65537) : JSON.stringify([ROW]));
    } });
  }
});
test("existing output is preserved and refused", async (t) => {
  const f = await fixture(t);
  const dir = join(f.root, "database-auth-backup-encrypted");
  await mkdir(dir);
  await writeFile(join(dir, "existing"), "untouched");
  await assert.rejects(f.run());
  assert.equal(await readFile(join(dir, "existing"), "utf8"), "untouched");
  assert.equal(f.calls.length, 0);
});
test("workflow has manual/main/production gates, ciphertext-only artifact and no secret in install/test steps", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/backup-database-auth.yml", import.meta.url), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /pull_request:|schedule:|push:|id-token:|contents: write/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /name: production/);
  assert.match(workflow, /postgresql-client-17 age/);
  assert.match(workflow, /if: success\(\)/);
  assert.match(workflow, /retention-days: 90/);
  assert.match(workflow, /path: .*database-auth\.pgdump\.age/);
  assert.match(workflow, /if-no-files-found: error/);
  assert.match(workflow, /group: deploy-production/);
});
