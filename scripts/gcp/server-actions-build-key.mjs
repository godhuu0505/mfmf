import { readFile } from "node:fs/promises";
import { PROJECT, PROJECT_NUMBER } from "./production-config.mjs";

export class BuildKeyError extends Error {}
const fail = () => { throw new BuildKeyError("Dedicated Server Actions build key is missing, inaccessible or invalid; details withheld."); };

export function validateBuildKeyReference(text, env) {
  if (env.GCP_PROJECT_ID !== PROJECT || env.GCP_PROJECT_NUMBER !== PROJECT_NUMBER || typeof text !== "string" || text.length > 512) fail();
  let value;
  try { value = JSON.parse(text); } catch { fail(); }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 ||
      !Object.hasOwn(value, "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY") ||
      typeof value.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY !== "string" ||
      !/^projects\/92772745697\/secrets\/mfmf-next-server-actions-key\/versions\/[1-9][0-9]*$/.test(value.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY)) fail();
  return value.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY;
}

export async function readServerActionsBuildKey(env, fetchImpl = fetch) {
  let reference;
  try { reference = validateBuildKeyReference(await readFile(new URL("./server-actions-key-version.json", import.meta.url), "utf8"), env); }
  catch { fail(); }
  let result;
  try {
    const response = await fetchImpl(`https://secretmanager.googleapis.com/v1/${reference}:access`, {
      method: "GET", headers: { Authorization: `Bearer ${env.GCP_ACCESS_TOKEN}` }, redirect: "error", signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) fail();
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length; if (size > 4096) fail(); chunks.push(Buffer.from(chunk));
    }
    result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch { fail(); }
  if (result?.name !== reference || typeof result.payload?.data !== "string" || result.payload.data.length > 128) fail();
  const bytes = Buffer.from(result.payload.data, "base64");
  if (bytes.toString("base64") !== result.payload.data) fail();
  const key = bytes.toString("utf8");
  if (!/^[A-Za-z0-9+/]{43}=$/.test(key) || Buffer.from(key, "base64").length !== 32 || Buffer.from(key, "base64").toString("base64") !== key) fail();
  return { reference, key };
}
