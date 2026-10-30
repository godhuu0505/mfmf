/** Bounded counters, no user/IP/path keys or storage. Resets on process restart. */
export function createBudget(limit: number, intervalMs: number, now = Date.now) {
  let start = now(); let used = 0;
  return () => {
    const time = now();
    if (time < start || time - start >= intervalMs) { start = time; used = 0; }
    if (used >= limit) return false;
    used++; return true;
  };
}
export function createTelemetryBudgets(now = Date.now) {
  const errorBurst = createBudget(3, 60_000, now); const errorDay = createBudget(60, 86_400_000, now);
  const metricBurst = createBudget(30, 60_000, now); const metricDay = createBudget(360, 86_400_000, now);
  return { error: () => errorBurst() && errorDay(), metric: () => metricBurst() && metricDay() };
}
