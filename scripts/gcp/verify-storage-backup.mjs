#!/usr/bin/env node
// Feed only decrypted archive bytes. No identities, files, network or extraction.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { verifyArchive, requireValue } from "./storage-backup-format.mjs";

export async function main(args = process.argv.slice(2), input = process.stdin, output = process.stdout, errors = process.stderr) {
  const timer = setTimeout(() => input.destroy(new Error("Input timeout")), 20 * 60_000);
  try {
    requireValue(args.length === 0 && !input.isTTY);
    const summary = await verifyArchive(input);
    await new Promise((done, reject) => output.write(`${JSON.stringify(summary)}\n`, (error) => error ? reject(error) : done()));
    return 0;
  } catch {
    try { await new Promise((done) => errors.write("Storage archive verification failed; details withheld.\n", done)); } catch { /* no diagnostics */ }
    return 1;
  } finally { clearTimeout(timer); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.stdout.on("error", () => { process.exitCode = 1; });
  process.stderr.on("error", () => { process.exitCode = 1; });
  process.exitCode = await main();
}
