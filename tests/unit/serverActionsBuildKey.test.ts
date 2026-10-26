import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readServerActionsBuildKey, validateBuildKeyReference } from "../../scripts/gcp/server-actions-build-key.mjs";

const key = Buffer.alloc(32, 6).toString("base64");
const reference = "projects/92772745697/secrets/mfmf-next-server-actions-key/versions/1";
const env = { GCP_PROJECT_ID: "mfmf-499612", GCP_PROJECT_NUMBER: "92772745697", GCP_ACCESS_TOKEN: "private-wif-fixture" };
const payload = () => ({ name: reference, payload: { data: Buffer.from(key).toString("base64") } });

describe("dedicated Server Actions build key", () => {
  it("accesses only the fixed dedicated version with a short-lived token and no redirects", async () => {
    const fetchImpl = vi.fn(async () => Response.json(payload()));
    expect(await readServerActionsBuildKey(env, fetchImpl)).toEqual({ reference, key });
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(`https://secretmanager.googleapis.com/v1/${reference}:access`, {
      method: "GET", headers: { Authorization: `Bearer ${env.GCP_ACCESS_TOKEN}` }, redirect: "error", signal: expect.any(AbortSignal),
    });
  });
  it.each(["wrong-name", "other-secret", "latest", "missing", "raw32", "newline", "wrong-size", "malformed-base64", "forbidden", "invalid-json", "oversize"])("rejects %s without exposing payloads", async (failure) => {
    const data = payload();
    if (failure === "wrong-name") data.name = reference.replace("92772745697", "123456789");
    if (failure === "other-secret") data.name = reference.replace("mfmf-next-server-actions-key", "mfmf-token-enc-key");
    if (failure === "latest") data.name = reference.replace(/1$/, "latest");
    if (failure === "missing") data.payload.data = "";
    if (failure === "raw32") data.payload.data = key;
    if (failure === "newline") data.payload.data = Buffer.from(`${key}\n`).toString("base64");
    if (failure === "wrong-size") data.payload.data = Buffer.from(Buffer.alloc(16).toString("base64")).toString("base64");
    if (failure === "malformed-base64") data.payload.data += "!";
    const fetchImpl = vi.fn(async () => failure === "forbidden" ? new Response("PRIVATE_BODY_MARKER", { status: 403 })
      : failure === "invalid-json" ? new Response("PRIVATE_BODY_MARKER")
      : failure === "oversize" ? new Response("PRIVATE_BODY_MARKER".repeat(1000)) : Response.json(data));
    const error = await readServerActionsBuildKey(env, fetchImpl).catch((value: Error) => value);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(key); expect(String(error)).not.toContain("PRIVATE_BODY_MARKER"); expect(String(error)).not.toContain(env.GCP_ACCESS_TOKEN);
  });
  it.each([null, [reference], 1, reference.replace("92772745697", "123456789"), reference.replace("mfmf-next-server-actions-key", "mfmf-token-enc-key"), reference.replace(/1$/, "latest"), reference.replace(/1$/, "0")])("rejects unreviewed reference %j", (value) => {
    expect(() => validateBuildKeyReference(JSON.stringify({ NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: value }), env)).toThrow();
  });
  it("rejects another project before contacting Secret Manager", async () => {
    const fetchImpl = vi.fn();
    await expect(readServerActionsBuildKey({ ...env, GCP_PROJECT_ID: "other-project" }, fetchImpl)).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("uses a cache-busting public version ARG, never the key value as ARG/ENV", async () => {
    const dockerfile = await readFile(new URL("../../Dockerfile.cloudrun", import.meta.url), "utf8");
    expect(dockerfile).toContain("ARG NEXT_SERVER_ACTIONS_KEY_VERSION");
    expect(dockerfile).toContain("env=NEXT_SERVER_ACTIONS_ENCRYPTION_KEY,required=true");
    expect(dockerfile).not.toMatch(/(?:ARG|ENV) NEXT_SERVER_ACTIONS_ENCRYPTION_KEY/);
    expect(dockerfile).toContain("node scripts/gcp/verify-server-actions-build.mjs");
  });
  it.each(["clean", "wrong-server", "static", "public", "html", "rsc", "pages-json"])("build verifier handles %s artifacts without leaking the fixture", async (failure) => {
    const scratch = await mkdtemp(join(tmpdir(), "mfmf-action-key-test-"));
    try {
      for (const path of [".next/server/app", ".next/server/pages", ".next/static", "public", ".next/standalone/.next/server"]) await mkdir(join(scratch, path), { recursive: true });
      for (const path of [".next/server/server-reference-manifest.json", ".next/standalone/.next/server/server-reference-manifest.json"]) {
        await writeFile(join(scratch, path), JSON.stringify({ encryptionKey: failure === "wrong-server" ? "wrong" : key }));
      }
      const exposed: Record<string, string> = { static: ".next/static/test.js", public: "public/test.txt", html: ".next/server/app/test.html", rsc: ".next/server/app/test.rsc", "pages-json": ".next/server/pages/test.json" };
      if (exposed[failure]) { await mkdir(dirname(join(scratch, exposed[failure])), { recursive: true }); await writeFile(join(scratch, exposed[failure]), key); }
      const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [fileURLToPath(new URL("../../scripts/gcp/verify-server-actions-build.mjs", import.meta.url))], {
          cwd: scratch, env: { NODE_ENV: "test", NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: key }, stdio: ["ignore", "pipe", "pipe"],
        });
        let output = ""; child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
        child.on("error", reject); child.on("close", (code) => resolve({ code, output }));
      });
      expect(result.code).toBe(failure === "clean" ? 0 : 1); expect(result.output).not.toContain(key); expect(result.output).not.toContain(scratch);
    } finally { await rm(scratch, { recursive: true, force: true }); }
  });
});
