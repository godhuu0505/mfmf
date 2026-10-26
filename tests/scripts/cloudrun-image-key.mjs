import { execFileSync } from "node:child_process";

// Public fixture only: the CI image must not persist the BuildKit secret as image ENV/history.
const fixture = Buffer.alloc(32, 6).toString("base64");
try {
  for (const args of [["image", "inspect", "mfmf-cloudrun:ci"], ["history", "--no-trunc", "mfmf-cloudrun:ci"]]) {
    const output = execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
    if (output.includes(fixture)) throw new Error();
  }
  console.log("BuildKit fixture absent from image configuration and history.");
} catch {
  console.error("Image secret-isolation verification failed; details withheld.");
  process.exitCode = 1;
}
