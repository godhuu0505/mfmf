import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

// Run inside the BuildKit secret mount. Never print the key, matching files, or file contents.
async function main() {
  const key = process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY;
  if (!key || !/^[A-Za-z0-9+/]{43}=$/.test(key) || Buffer.from(key, "base64").length !== 32) throw new Error();
  for (const path of [".next/server/server-reference-manifest.json", ".next/standalone/.next/server/server-reference-manifest.json"]) {
    const manifest = JSON.parse(await readFile(path, "utf8"));
    if (manifest.encryptionKey !== key) throw new Error();
  }
  const needles = [Buffer.from(key), Buffer.from(key, "base64"), Buffer.from(Buffer.from(key, "base64").toString("hex"))];
  async function inspect(path, prerenderOnly = false, optional = false) {
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); }
    catch (error) { if (optional && error.code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error();
      if (entry.isDirectory()) await inspect(child, prerenderOnly);
      else if (entry.isFile() && (!prerenderOnly || /\.(html|rsc|json|meta|body)$/.test(entry.name))) {
        const content = await readFile(child);
        if (needles.some((needle) => content.includes(needle))) throw new Error();
      }
    }
  }
  await inspect(".next/static");
  await inspect("public");
  await inspect(".next/server/app", true);
  await inspect(".next/server/pages", true, true);
  console.log("Server Actions key verified in private server manifests and absent from client assets.");
}

main().catch(() => {
  console.error("Server Actions build-key verification failed; key and artifact details withheld.");
  process.exitCode = 1;
});
