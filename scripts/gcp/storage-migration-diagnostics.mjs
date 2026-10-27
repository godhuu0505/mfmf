// Diagnostic data is constructed here, never copied from provider/error bodies.
const STAGES = new Set(["verify-buckets", "expire-reservations", "validate-expired-count",
  "list-deleted", "validate-deleted-page", "validate-deleted-asset"]);
class HttpFailure extends Error {
  constructor(status) {
    super("Storage operator HTTP failure; details withheld.");
    this.status = Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
  }
}
class CleanupFailure extends Error {
  constructor(stage, error) {
    super("Storage cleanup failed; details withheld.");
    this.stage = stage;
    this.status = error instanceof HttpFailure ? error.status : undefined;
  }
}
export function failStorageHttp(status) { throw new HttpFailure(status); }
export function storageHttpStatus(error) { return error instanceof HttpFailure ? error.status : undefined; }
export async function cleanupStage(stage, operation) {
  if (!STAGES.has(stage)) throw new Error("Invalid cleanup diagnostic stage.");
  try { return await operation(); }
  catch (error) { throw new CleanupFailure(stage, error); }
}
export function cleanupDiagnostic(error) {
  if (!(error instanceof CleanupFailure) || !STAGES.has(error.stage)) return null;
  return `Storage cleanup stopped at ${error.stage}${error.status === undefined ? "" : ` (HTTP ${error.status})`}; details withheld.\n`;
}
