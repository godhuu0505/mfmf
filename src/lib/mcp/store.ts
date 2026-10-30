import "server-only";
import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { mcpConfiguration } from "./config";

/** OAuth hashes only. No business records or browser Firestore access. */
export function database() {
  const { projectId, databaseId } = mcpConfiguration();
  if (process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Firestore emulator is not permitted in this server.");
  const app = getApps().find(item => item.name === "mfmf-mcp-oauth") ?? initializeApp({ projectId, credential: applicationDefault() }, "mfmf-mcp-oauth");
  if (app.options.projectId !== projectId) throw new Error("OAuth storage project mismatch.");
  return getFirestore(app, databaseId);
}
