import { pathToFileURL } from "node:url";
import { backupContext, backupToken, backupJobDiagnostic, BackupJobError } from "./backup-job-config.mjs";
import { createEncryptedBackup, diagnostic as identityDiagnostic, FIXED } from "./identity-backup.mjs";
import { publishIdentityBackup } from "./publish-identity-backup.mjs";
import { runDatabaseBackupRetention, retentionDiagnostic } from "./database-backup-retention.mjs";

export async function runBackupJob({ env = process.env, fetchImpl = fetch, encrypt = createEncryptedBackup,
  publish = publishIdentityBackup, retain = runDatabaseBackupRetention } = {}) {
  const context = backupContext(env);
  const token = await backupToken(env, fetchImpl);
  if (context.job === "mfmf-db-retention") return retain({ env, accessToken: token, fetchImpl });
  const { ciphertext, receipt } = await encrypt({ token, recipient: FIXED.recipient, fetchImpl });
  try { return await publish({ ciphertext, receipt, token, execution: context.execution, sourceCommit: context.sourceCommit, fetchImpl }); }
  finally { if (Buffer.isBuffer(ciphertext)) ciphertext.fill(0); }
}
async function main() {
  if (process.argv.length === 2 || process.argv.length === 3 && process.argv[2] === "--plan") {
    console.log(JSON.stringify({ mode: "plan", requests: 0, secretsRead: false, jobs: ["mfmf-identity-backup", "mfmf-db-retention"],
      identityRetentionDays: 30, preUpgradeRetentionDaysMinimum: 14 })); return;
  }
  if (process.argv.length !== 3 || process.argv[2] !== "--execute") throw new BackupJobError("context");
  console.log(JSON.stringify(await runBackupJob()));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => {
  console.error(JSON.stringify(backupJobDiagnostic(error) ?? retentionDiagnostic(error) ?? identityDiagnostic(error))); process.exitCode = 1;
});
