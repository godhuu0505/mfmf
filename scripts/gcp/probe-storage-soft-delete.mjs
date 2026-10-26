#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { localOperatorToken } from "./restore-storage-backup.mjs";
import { createOperatorGcs } from "./storage-migration-gcs.mjs";
import { requireValue, sha256 } from "./storage-backup-format.mjs";

export async function probeSoftDelete({ apply = false, getToken = localOperatorToken, fetchImpl = fetch, uuid = randomUUID,
  signal = AbortSignal.timeout(180_000) } = {}) {
  if (!apply) return { operation: "soft-delete-probe-plan", cloudWrites: 0 };
  const gcs = createOperatorGcs({ token: await getToken(), fetchImpl, signal });
  await gcs.verifyBuckets();
  const bytes = Buffer.from("mfmf synthetic soft-delete rehearsal v1\n");
  const id = uuid(); const name = `_incoming/${id}`;
  let liveGeneration;
  try {
    const first = await gcs.restoreIncoming("photos", id, bytes); liveGeneration = first.generation;
    requireValue(sha256(await gcs.read("photos", name, first.generation, bytes.length)) === sha256(bytes));
    await gcs.remove("photos", name, first.generation); liveGeneration = undefined;
    requireValue(await gcs.stat("photos", name, undefined, true) === null);
    const restored = await gcs.restoreIncomingGeneration("photos", name, first.generation); liveGeneration = restored.generation;
    requireValue(restored.generation !== first.generation && Number(restored.size) === bytes.length);
    requireValue(sha256(await gcs.read("photos", name, restored.generation, bytes.length)) === sha256(bytes));
    await gcs.remove("photos", name, restored.generation); liveGeneration = undefined;
    requireValue(await gcs.stat("photos", name, undefined, true) === null);
    return { operation: "soft-delete-probe", syntheticObjects: 1, restoredObjects: 1, verifiedBytes: bytes.length, deletedTestGenerations: 2 };
  } finally {
    if (liveGeneration) { try { await gcs.remove("photos", name, liveGeneration); } catch { /* fail closed; incoming lifecycle remains a backstop */ } }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.stdout.on("error", () => { process.exitCode = 1; }); process.stderr.on("error", () => { process.exitCode = 1; });
  try {
    const args = process.argv.slice(2);
    requireValue(process.env.GITHUB_ACTIONS !== "true" && (args.length === 0 || (args.length === 1 && args[0] === "--apply")));
    const result = await probeSoftDelete({ apply: args.length === 1 });
    await new Promise((done, reject) => process.stdout.write(`${JSON.stringify(result)}\n`, (error) => error ? reject(error) : done()));
  } catch { process.stderr.write("Storage soft-delete probe failed; details withheld. Original objects were not targeted.\n"); process.exitCode = 1; }
}
