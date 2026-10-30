import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const sdk = vi.hoisted(() => ({ flush: vi.fn() }));
vi.mock("@sentry/nextjs", () => sdk);
import { flushTelemetry } from "@/lib/telemetry/flush";

beforeEach(() => { vi.useFakeTimers(); sdk.flush.mockReset(); });
afterEach(() => vi.useRealTimers());
describe("bounded telemetry delivery", () => {
  it("waits for slow transport completion without ending at the old 500ms cutoff", async () => {
    sdk.flush.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 1_200)));
    let completed = false;
    const pending = flushTelemetry().then(() => { completed = true; });
    await vi.advanceTimersByTimeAsync(600); expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(600); await pending;
    expect(completed).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds the total wait even when the SDK never settles", async () => {
    sdk.flush.mockImplementation(() => new Promise(() => {}));
    let completed = false;
    const pending = flushTelemetry().then(() => { completed = true; });
    await vi.advanceTimersByTimeAsync(3_499); expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await pending;
    expect(completed).toBe(true); expect(vi.getTimerCount()).toBe(0);
    expect(sdk.flush).toHaveBeenCalledTimes(1);
  });
  it.each([true, false])("returns promptly when delivery settles with %s", async (result) => {
    sdk.flush.mockResolvedValue(result); await flushTelemetry();
    expect(vi.getTimerCount()).toBe(0); expect(sdk.flush).toHaveBeenCalledTimes(1);
  });
  it("swallows failures without retries", async () => {
    sdk.flush.mockRejectedValue(new Error("FIXTURE_PRIVATE_FAILURE"));
    await expect(flushTelemetry()).resolves.toBeUndefined();
    expect(sdk.flush).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it("handles a rejection arriving after the outer deadline", async () => {
    sdk.flush.mockImplementation(() => new Promise((_resolve, reject) => setTimeout(() => reject(new Error("FIXTURE_LATE_FAILURE")), 4_000)));
    const pending = flushTelemetry(); await vi.advanceTimersByTimeAsync(3_500); await pending;
    await vi.advanceTimersByTimeAsync(500);
    expect(sdk.flush).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
});
