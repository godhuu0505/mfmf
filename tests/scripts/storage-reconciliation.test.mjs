import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { MAX_INPUT_BYTES, main, reconcileStorageManifest } from "../../scripts/gcp/reconcile-storage-manifest.mjs";

const cli = new URL("../../scripts/gcp/reconcile-storage-manifest.mjs", import.meta.url);
const fixture = () => JSON.parse(readFileSync(new URL("../fixtures/gcp/storage-manifest.synthetic.json", import.meta.url), "utf8"));
const categories = (report) => report.findings.map((finding) => finding.category);
const run = (input, args = []) => spawnSync(process.execPath, [cli.pathname, ...args], {
  input: typeof input === "object" && !Buffer.isBuffer(input) ? JSON.stringify(input) : input,
  encoding: "utf8", timeout: 5000,
  env: { PATH: process.env.PATH },
});

test("both buckets and all four references compare without claiming migration readiness", () => {
  const report = reconcileStorageManifest(fixture());
  assert.equal(report.comparison, "matched");
  assert.equal(report.readiness, "not-assessed");
  assert.equal(report.summary.matchingPairs, 4);
  assert.equal(report.summary.unsetAvatars, 1);
  assert.deepEqual(categories(report), ["tombstone-absent"]);
  const result = run(fixture());
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).comparison, "matched");
  assert.equal(result.stderr, "");
});

test("missing referenced source and destination objects are independent findings", () => {
  const manifest = fixture();
  manifest.source.splice(0, 1);
  manifest.destination.splice(1, 1);
  const report = reconcileStorageManifest(manifest);
  assert.equal(report.comparison, "differences");
  assert.ok(categories(report).includes("referenced-source-missing"));
  assert.ok(categories(report).includes("referenced-destination-missing"));
  assert.ok(categories(report).includes("destination-only"));
  assert.ok(categories(report).includes("destination-missing"));
  assert.equal(run(manifest).status, 2);
});

test("unreferenced objects on either side are review findings, never deletion instructions", () => {
  const manifest = fixture();
  manifest.references.record_photos = [];
  const report = reconcileStorageManifest(manifest);
  assert.ok(categories(report).includes("source-unreferenced"));
  assert.ok(categories(report).includes("destination-unreferenced"));
  assert.equal(report.comparison, "differences");
  assert.equal(report.readiness, "not-assessed");
});

test("size and checksum mismatches are reported separately even when another checksum matches", () => {
  const manifest = fixture();
  manifest.source[0].hashes.md5 = "a".repeat(32);
  manifest.destination[0].hashes.md5 = "b".repeat(32);
  manifest.destination[0].size++;
  const report = reconcileStorageManifest(manifest);
  assert.ok(categories(report).includes("size-mismatch"));
  assert.ok(categories(report).includes("hash-mismatch"));
  assert.equal(report.summary.matchingPairs, 3);
});

test("size equality and absent or disjoint checksum algorithms cannot establish a match", () => {
  for (const hashes of [{}, { md5: "a".repeat(32) }]) {
    const manifest = fixture();
    manifest.destination[0].hashes = hashes;
    const report = reconcileStorageManifest(manifest);
    assert.equal(report.comparison, "inconclusive");
    assert.ok(report.findings.some((finding) => finding.detail === "no-common-hash"));
    assert.equal(run(manifest).status, 2);
  }
});

test("unknown size remains inconclusive even when checksums match", () => {
  const manifest = fixture();
  manifest.source[0].size = null;
  const report = reconcileStorageManifest(manifest);
  assert.equal(report.comparison, "inconclusive");
  assert.ok(report.findings.some((finding) => finding.detail === "missing-size"));
});

test("explicit checksum hex encodings compare case-insensitively", () => {
  const manifest = fixture();
  manifest.source[0].hashes = { md5: "a".repeat(32), crc32c: "1234abcd" };
  manifest.destination[0].hashes = { md5: "A".repeat(32), crc32c: "1234ABCD" };
  assert.equal(reconcileStorageManifest(manifest).comparison, "matched");
});

test("deletion history distinguishes surviving objects, conflicting references and absent paths", () => {
  const manifest = fixture();
  const { bucket, path } = manifest.source[0];
  manifest.tombstones.push({ bucket, path });
  const report = reconcileStorageManifest(manifest);
  for (const category of ["tombstone-reference", "tombstone-source-present", "tombstone-destination-present", "tombstone-absent"]) {
    assert.ok(categories(report).includes(category));
  }
  assert.equal(report.summary.matchingPairs, 3);
  assert.equal(report.comparison, "differences");
  // Tombstoned objects are excluded from ordinary copy-comparison categories.
  assert.ok(!categories(report).includes("destination-missing"));
});

test("bucket identity prevents an avatar with the same path from satisfying a photo reference", () => {
  const manifest = fixture();
  manifest.destination[0].bucket = "avatars";
  const report = reconcileStorageManifest(manifest);
  assert.ok(categories(report).includes("referenced-destination-missing"));
  assert.ok(categories(report).includes("destination-only"));
});

test("object names remain opaque including legacy paths, escapes, case and whitespace", () => {
  for (const [source, destination] of [["legacy-owner/photo.jpg", "legacy-owner/photo.jpg"], ["a%2Fb", "a/b"], ["Photo.jpg", "photo.jpg"], [" photo.jpg", "photo.jpg"], ["a/../b", "b"]]) {
    const manifest = fixture();
    manifest.source[0].path = source;
    manifest.destination[0].path = destination;
    manifest.references.record_photos = [source];
    assert.equal(reconcileStorageManifest(manifest).comparison, source === destination ? "matched" : "differences");
  }
});

test("repeated DB references are valid; null avatar means unset, null photo or empty paths are invalid", () => {
  const manifest = fixture();
  manifest.references.profiles.push(manifest.references.profiles[0]);
  assert.equal(reconcileStorageManifest(manifest).comparison, "matched");
  for (const [table, path] of [["record_photos", null], ["profiles", ""], ["pets", "\nprivate"]]) {
    const invalid = fixture();
    invalid.references[table] = [path];
    assert.throws(() => reconcileStorageManifest(invalid), /values and diagnostic details withheld/);
  }
});

test("duplicate objects or tombstones are rejected instead of choosing an arbitrary entry", () => {
  for (const collection of ["source", "destination", "tombstones"]) {
    const manifest = fixture();
    manifest[collection].push({ ...manifest[collection][0] });
    assert.throws(() => reconcileStorageManifest(manifest), /values and diagnostic details withheld/);
  }
});

test("invalid shapes, extra fields, ETag inference and malformed metadata fail closed", () => {
  const mutations = [
    (m) => { m.formatVersion = 2; },
    (m) => { delete m.references.pets; },
    (m) => { m.references.google_avatar_url = []; },
    (m) => { m.source[0].bucket = "other"; },
    (m) => { m.source[0].size = -1; },
    (m) => { m.source[0].size = Number.MAX_SAFE_INTEGER + 1; },
    (m) => { m.source[0].hashes = { etag: "a".repeat(32) }; },
    (m) => { m.source[0].hashes = { md5: "not-a-checksum" }; },
    (m) => { m.source[0].hashes = []; },
    (m) => { m.source[0].signedUrl = "PRIVATE_FIXTURE"; },
    (m) => { m.destination = null; },
    (m) => { m.references.pets = Array(5001).fill(null); },
  ];
  for (const mutate of mutations) {
    const manifest = fixture(); mutate(manifest);
    assert.throws(() => reconcileStorageManifest(manifest), /values and diagnostic details withheld/);
  }
});

test("empty and tombstone-only manifests do not become successful migration checks", () => {
  for (const tombstones of [[], fixture().tombstones]) {
    const manifest = { formatVersion: 1, source: [], destination: [], references: { record_photos: [], profiles: [], households: [], pets: [] }, tombstones };
    assert.equal(reconcileStorageManifest(manifest).comparison, "empty");
    assert.equal(reconcileStorageManifest(manifest).readiness, "not-assessed");
    assert.equal(run(manifest).status, 2);
  }
});

test("successful and failed CLI output withholds paths, hashes, sizes and arbitrary errors", () => {
  const manifest = fixture();
  manifest.source[0].path = "PRIVATE_PERSON_AND_PATH";
  manifest.source[0].size = 987654321;
  manifest.source[0].hashes.sha256 = "f".repeat(64);
  const differences = run(manifest);
  assert.equal(differences.status, 2);
  assert.doesNotMatch(differences.stdout + differences.stderr, /PRIVATE_PERSON_AND_PATH|987654321|f{64}|synthetic-/);
  for (const input of ['{"PRIVATE_FIXTURE":', '{"private":"PRIVATE_FIXTURE"}', Buffer.from([0xff]), '"PRIVATE_FIXTURE"', ' '.repeat(MAX_INPUT_BYTES + 1)]) {
    const result = run(input);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "Invalid manifest; values and diagnostic details withheld.\n");
  }
  const args = run("", ["PRIVATE_FILENAME"]);
  assert.equal(args.status, 1);
  assert.doesNotMatch(args.stdout + args.stderr, /PRIVATE_FILENAME/);
});

test("stream failures and broken output produce fixed diagnostics without error contents", async () => {
  let errors = "";
  const errorOutput = new Writable({ write(chunk, encoding, callback) { errors += chunk; callback(); } });
  const failingInput = new Readable({ read() { this.destroy(new Error("PRIVATE_STREAM_ERROR")); } });
  assert.equal(await main([], failingInput, process.stdout, errorOutput), 1);
  assert.doesNotMatch(errors, /PRIVATE_STREAM_ERROR/);
  errors = "";
  const failingOutput = new Writable({ write(chunk, encoding, callback) { callback(new Error("PRIVATE_PIPE_ERROR")); } });
  failingOutput.on("error", () => {});
  assert.equal(await main([], Readable.from([Buffer.from(JSON.stringify(fixture()))]), failingOutput, errorOutput), 1);
  assert.doesNotMatch(errors, /PRIVATE_PIPE_ERROR/);
});

test("comparison does not mutate its manifest or return input values", () => {
  const manifest = fixture();
  const before = JSON.stringify(manifest);
  const report = reconcileStorageManifest(manifest);
  assert.equal(JSON.stringify(manifest), before);
  assert.doesNotMatch(JSON.stringify(report), /synthetic-|[a-f0-9]{64}/);
});
