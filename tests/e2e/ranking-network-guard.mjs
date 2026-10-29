// Loaded only through Playwright's local server NODE_OPTIONS. Not an app import.
// A missed browser interception must fail closed before any Google credential/API call.
const originalFetch = globalThis.fetch;
globalThis.fetch = async function guardedFetch(input, init) {
  let host;
  try { host = new URL(input instanceof Request ? input.url : String(input)).hostname; } catch { /* native fetch validates other inputs */ }
  if (["discoveryengine.googleapis.com", "metadata.google.internal", "169.254.169.254"].includes(host)) {
    throw new Error("External ranking access is blocked in local E2E tests.");
  }
  return originalFetch(input, init);
};
