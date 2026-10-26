#!/usr/bin/env node
// Keyholder-local rehearsal only. Source paths never become destination names.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { decodeArchiveForOperator, requireValue, sha256, MAX_TOTAL_BYTES, MAX_JSON_BYTES } from "./storage-backup-format.mjs";
import { createOperatorGcs, OPERATOR_SA, MIGRATION_PROJECT } from "./storage-migration-gcs.mjs";

export async function localOperatorToken() {
  return new Promise((done, reject) => {
    execFile("/Users/godai.tanaka/.local/share/mfmf-tools/google-cloud-sdk/bin/gcloud", [
      "auth", "print-access-token", `--impersonate-service-account=${OPERATOR_SA}`, `--project=${MIGRATION_PROJECT}`, "--quiet",
    ], { timeout: 30_000, maxBuffer: 16_384, encoding: "utf8", env: {
      PATH: process.env.PATH, HOME: process.env.HOME,
      CLOUDSDK_CORE_DISABLE_FILE_LOGGING: "1", CLOUDSDK_CORE_LOG_HTTP: "false",
      CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK: "true", CLOUDSDK_CORE_DISABLE_PROMPTS: "1",
    } }, (error, stdout) => error ? reject(new Error("Operator authentication failed")) : done(stdout.trim()));
  });
}

export async function restoreBackup({ input, apply = false, getToken = localOperatorToken,
  fetchImpl = fetch, uuid = randomUUID, signal = AbortSignal.timeout(20 * 60_000) }) {
  let size = 0; const chunks = [];
  for await (const chunk of input) {
    size += chunk.length; requireValue(size <= MAX_TOTAL_BYTES + 4 * MAX_JSON_BYTES); chunks.push(chunk);
  }
  const archive = await decodeArchiveForOperator(Readable.from([Buffer.concat(chunks, size)]));
  if (!apply) return { ...archive.summary, operation: "isolated-restore-plan", cloudWrites: 0 };
  const gcs = createOperatorGcs({ token: await getToken(), fetchImpl, signal });
  await gcs.verifyBuckets();
  const pending = [];
  let restored = 0;
  try {
    const ids = new Set();
    for (const object of archive.objects) {
      const bucket = object.bucket === "daycare-photos" ? "photos" : "avatars";
      const id = uuid(); requireValue(!ids.has(id)); ids.add(id);
      const result = await gcs.restoreIncoming(bucket, id, object.bytes);
      const ref = { bucket, name: `_incoming/${id}`, generation: result.generation };
      pending.push(ref);
      requireValue(Number(result.size) === object.bytes.length);
      requireValue(sha256(await gcs.read(bucket, ref.name, ref.generation, object.bytes.length)) === object.sha256);
      restored++;
      await gcs.remove(bucket, ref.name, ref.generation);
      requireValue(await gcs.stat(bucket, ref.name, ref.generation, true) === null);
      pending.pop();
    }
    return { operation: "isolated-storage-restore", restoredObjects: restored, verifiedBytes: archive.summary.totalBytes,
      deletedTestGenerations: restored, readiness: "not-assessed", decryptionExitStatus: "caller-must-check" };
  } finally {
    // Only generations created by this invocation, never a source/final object.
    for (const ref of pending) {
      try { await gcs.remove(ref.bucket, ref.name, ref.generation); } catch { /* failure is not success; incoming lifecycle is the fallback */ }
    }
  }
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const controller = new AbortController(); const stop = () => controller.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  const timer = setTimeout(() => { controller.abort(); process.stdin.destroy(new Error("Input timeout")); }, 20 * 60_000);
  try {
    requireValue(env.GITHUB_ACTIONS !== "true" && !process.stdin.isTTY && (args.length === 0 || (args.length === 1 && args[0] === "--apply")));
    const result = await restoreBackup({ input: process.stdin, apply: args.length === 1, signal: controller.signal });
    await new Promise((done, reject) => process.stdout.write(`${JSON.stringify(result)}\n`, (error) => error ? reject(error) : done()));
    return 0;
  } catch { process.stderr.write("Isolated Storage restore failed; details withheld. Original objects were not targeted.\n"); return 1; }
  finally { clearTimeout(timer); process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.stdout.on("error", () => { process.exitCode = 1; }); process.stderr.on("error", () => { process.exitCode = 1; });
  process.exitCode = await main();
}
