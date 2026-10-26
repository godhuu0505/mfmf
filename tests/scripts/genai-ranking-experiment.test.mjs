import assert from "node:assert/strict";
import test from "node:test";
import { MODEL, run } from "../../scripts/genai-ranking-experiment.mjs";

function harness(overrides = {}) {
  let stdout = "";
  let stderr = "";
  return {
    deps: {
      exec: async () => { throw new Error("authentication must not run"); },
      request: async () => { throw new Error("network must not run"); },
      out: (line) => { stdout += line; },
      err: (line) => { stderr += line; },
      ...overrides,
    },
    output: () => ({ stdout, stderr }),
  };
}
const liveArgs = ["--execute", "--project=example-project"];

test("default mode never authenticates or sends a request", async () => {
  const h = harness();
  assert.equal(await run([], h.deps), 0);
  assert.equal(JSON.parse(h.output().stdout).requestCount, 0);
});

test("rejects arbitrary record/query inputs and requires an explicit project", async () => {
  for (const args of [["--execute"], ["--query=private"], ["--records=private.json"], ["--project=bad/path"], ["--execute", "--execute"]]) {
    const h = harness();
    assert.equal(await run(args, h.deps), 1);
    assert.equal(h.output().stdout, "");
  }
});

test("one fixed request; token stays out of argv and output; response details are projected away", async () => {
  let calls = 0;
  const h = harness({
    exec: async (file, args, options) => {
      assert.equal(file, "gcloud");
      assert.deepEqual(args, ["auth", "print-access-token", "--quiet"]);
      assert.equal(options.encoding, "utf8");
      return { stdout: "synthetic-secret-token\n" };
    },
    request: async (url, options) => {
      calls++;
      assert.equal(url, "https://discoveryengine.googleapis.com/v1/projects/example-project/locations/global/rankingConfigs/default_ranking_config:rank");
      assert.equal(options.redirect, "error");
      assert.equal(options.headers.Authorization, "Bearer synthetic-secret-token");
      const body = JSON.parse(options.body);
      assert.equal(body.model, MODEL);
      assert.equal(body.records.length, 3);
      assert.equal(body.ignoreRecordDetailsInResponse, true);
      assert.ok(body.records.every(({ id, title }) => id.startsWith("synthetic-") && title.startsWith("架空記録：")));
      return { ok: true, json: async () => ({ records: body.records.map(({ id }, i) => ({ id, score: 0.9 - i * 0.2, title: "do-not-log", content: "do-not-log" })) }) };
    },
  });
  assert.equal(await run(liveArgs, h.deps), 0);
  assert.equal(calls, 1);
  assert.doesNotMatch(h.output().stdout + h.output().stderr, /synthetic-secret-token|do-not-log/);
  assert.ok(JSON.parse(h.output().stdout).records.every((record) => Object.keys(record).join(",") === "id,score"));
});

test("credential failure withholds raw subprocess output", async () => {
  const h = harness({ exec: async () => { throw new Error("synthetic-secret-token"); } });
  assert.equal(await run(liveArgs, h.deps), 1);
  assert.doesNotMatch(h.output().stderr, /synthetic-secret-token/);
});

test("HTTP failure does not read/log body or retry", async () => {
  let calls = 0;
  const h = harness({
    exec: async () => ({ stdout: "synthetic-token" }),
    request: async () => { calls++; return { ok: false, status: 503, json: async () => { throw new Error("body must not be read"); } }; },
  });
  assert.equal(await run(liveArgs, h.deps), 1);
  assert.equal(calls, 1);
  assert.match(h.output().stderr, /HTTP 503/);
});

test("unknown IDs and invalid scores fail closed without printing response", async () => {
  for (const records of [[
    { id: "private-id", score: 1 }, { id: "synthetic-rain", score: 0.5 }, { id: "synthetic-grooming", score: 0 },
  ], [
    { id: "synthetic-rest", score: 1 }, { id: "synthetic-rain", score: 2 }, { id: "synthetic-grooming", score: 0 },
  ]]) {
    const h = harness({
      exec: async () => ({ stdout: "synthetic-token" }),
      request: async () => ({ ok: true, json: async () => ({ records }) }),
    });
    assert.equal(await run(liveArgs, h.deps), 1);
    assert.equal(h.output().stdout, "");
    assert.doesNotMatch(h.output().stderr, /private-id/);
  }
});
