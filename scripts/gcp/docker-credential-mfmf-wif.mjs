#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";

// Docker が子プロセスの pipe で呼ぶ credential helper。ログや credential file は作らない。
export function dockerCredential(command, server, token) {
  if (command !== "get" || server.trim() !== "asia-northeast1-docker.pkg.dev" || !token || /[\r\n]/.test(token)) {
    throw new Error("Credential request rejected.");
  }
  return { Username: "oauth2accesstoken", Secret: token };
}

// 一時ディレクトリが symlink（macOS の /var → /private/var 等）でも直接実行を判定する。
let isEntrypoint = false;
try {
  isEntrypoint = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
} catch { /* imported by a runner without a file entrypoint */ }

if (isEntrypoint) {
  try {
    let server = "";
    for await (const chunk of process.stdin) {
      server += chunk;
      if (server.length > 256) throw new Error("Invalid server");
    }
    // stdout は Docker の credential protocol 専用。親のログへは流さない。
    process.stdout.write(JSON.stringify(dockerCredential(process.argv[2], server, process.env.GCP_ACCESS_TOKEN)));
  } catch {
    process.stderr.write("Credential request rejected.\n");
    process.exitCode = 1;
  }
}
