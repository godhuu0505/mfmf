// Operator-only real contract test. No cloud call occurs without --execute.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const RUNTIME = "mfmf-runtime@mfmf-499612.iam.gserviceaccount.com";
const ORIGIN = "https://mfmf-candidate-wspqvmhj6q-an.a.run.app";
const fail = () => { throw new Error("Storage contract failed; URL, token and API details withheld."); };

export async function runStorageContract({ storage, png, fetchImpl = fetch, log = console.log }) {
  const cleanup = [];
  const request = async (url, options, expected) => {
    const response = await fetchImpl(url, { ...options, redirect: "manual", signal: AbortSignal.timeout(30_000) });
    if (response.status !== expected) { await response.body?.cancel(); fail(); }
    await response.body?.cancel();
    return response;
  };
  try {
    for (const bucket of ["photos", "avatars"]) {
      const reservationId = randomUUID(); const ownerId = randomUUID(); const householdId = bucket === "photos" ? randomUUID() : null;
      const entityId = bucket === "photos" ? randomUUID() : ownerId;
      const incoming = { bucket, name: `_incoming/${reservationId}` };
      // Registered before the first upload so a lost upload response still has a cleanup target.
      cleanup.push(incoming);
      const upload = await storage.signUpload({ ...incoming, size: png.length, contentType: "image/png" });
      log(`Testing ${bucket}: browser CORS restrictions.`);
      const preflight = await request(upload.url, { method: "OPTIONS", headers: { Origin: ORIGIN, "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": Object.keys(upload.headers).join(",") } }, 200);
      if (preflight.headers.get("access-control-allow-origin") !== ORIGIN) fail();
      const blocked = await request(upload.url, { method: "OPTIONS", headers: { Origin: "https://not-mfmf.invalid", "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": Object.keys(upload.headers).join(",") } }, 200);
      if (blocked.headers.has("access-control-allow-origin")) fail();
      log(`Testing ${bucket}: exact byte count and signed-header tamper rejection.`);
      await request(upload.url, { method: "PUT", headers: upload.headers, body: Buffer.concat([png, Buffer.from([0])]) }, 400);
      await request(upload.url, { method: "PUT", headers: upload.headers, body: png.subarray(0, -1) }, 400);
      await request(upload.url, { method: "PUT", headers: { ...upload.headers, "content-type": "image/jpeg" }, body: png }, 403);
      const missingHeader = { ...upload.headers }; delete missingHeader["x-goog-content-length-range"];
      await request(upload.url, { method: "PUT", headers: missingHeader, body: png }, 403);
      await request(upload.url, { method: "PUT", headers: { ...upload.headers, "x-goog-if-generation-match": "1" }, body: png }, 403);
      log(`Testing ${bucket}: real upload, image decode and immutable publication.`);
      await request(upload.url, { method: "PUT", headers: upload.headers, body: png }, 200);
      const source = await storage.stat(incoming); if (!source) fail();
      await request(upload.url, { method: "PUT", headers: upload.headers, body: png }, 412);
      const binding = { schema: "1", state: "ready", kind: bucket === "photos" ? "record-photo" : "profile-avatar", entityId, householdId, ownerId, reservationId, sourceGeneration: source.generation };
      const destinationName = `${householdId ?? ownerId}/${bucket === "photos" ? entityId : "avatars"}/${reservationId}`;
      const destination = { bucket, name: destinationName }; cleanup.push(destination);
      const final = await storage.publish({ source, destinationName, binding, expectedSize: png.length, contentType: "image/png" });
      const readUrl = await storage.signRead(final, 300);
      await request(readUrl, {}, 200);
      let conflict = false;
      try { await storage.publish({ source, destinationName, binding, expectedSize: png.length, contentType: "image/png" }); }
      catch (error) { conflict = error?.code === "conflict"; }
      if (!conflict) fail();
      log(`Testing ${bucket}: deleted incoming replay, old-generation deletion and final signed URL invalidation.`);
      await storage.deleteGeneration(source);
      // Demonstrate that generation=0 is not a single-use credential after deletion.
      await request(upload.url, { method: "PUT", headers: upload.headers, body: png }, 200);
      const replayed = await storage.stat(incoming);
      if (!replayed || replayed.generation === source.generation || (await storage.stat(final))?.generation !== final.generation) fail();
      await storage.deleteGeneration(source); // an old deletion must not delete the new incoming generation
      if (!(await storage.stat(replayed))) fail();
      await storage.deleteGeneration(final);
      const deleted = await fetchImpl(readUrl, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
      const gone = deleted.status === 404; await deleted.body?.cancel(); if (!gone) fail();
      log(`Contract passed for ${bucket}: runtime IAM, size/MIME/create-only, CORS, generation isolation, metadata replacement and deleted signed URL.`);
    }
  } finally {
    let failed = false;
    for (const object of cleanup.reverse()) {
      try { const metadata = await storage.stat(object); if (metadata) await storage.deleteGeneration(metadata); }
      catch { failed = true; }
    }
    if (failed) throw new Error("Storage contract cleanup could not be verified; inspect isolated fixture objects. Details withheld.");
  }
  log("Real GCS contract completed. Only isolated fixture objects were written; soft-deleted fixtures retain their seven-day policy.");
}

async function main() {
  if (process.argv.length === 2) { console.log("Plan only. Run with Node 22 --conditions=react-server --experimental-strip-types and --execute after reviewing the fixed-bucket fixture writes."); return; }
  if (process.argv.length !== 3 || process.argv[2] !== "--execute") fail();
  const { createGcsStorage } = await import("../../src/lib/gcsStorage.ts");
  const { default: sharp } = await import("sharp");
  let token;
  try {
    const result = await promisify(execFile)("gcloud", ["auth", "print-access-token", `--impersonate-service-account=${RUNTIME}`, "--quiet"], { encoding: "utf8", maxBuffer: 16_384 });
    token = result.stdout.trim();
  } catch { fail(); }
  if (!token || /[\r\n]/.test(token)) fail();
  // Every JSON API and signBlob call uses the runtime identity, not the operator's broader token.
  const storage = createGcsStorage({ getAccessToken: async () => token });
  const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: "red" } }).png().toBuffer();
  await runStorageContract({ storage, png });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error("Real storage contract failed; credentials, signed URLs and API details withheld. Inspect fixture cleanup before retrying."); process.exitCode = 1; });
}
