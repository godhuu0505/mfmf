import * as Sentry from "@sentry/nextjs";

/** Keep request-based CPU available for the three-second transport, with one total deadline. */
export async function flushTelemetry(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Sentry.flush(3_500),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, 3_500); }),
    ]);
  } catch { /* Monitoring must not replace the application's result or retry a send. */ }
  finally { clearTimeout(timer); }
}
