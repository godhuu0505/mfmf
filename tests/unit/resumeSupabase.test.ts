import { describe, expect, it, vi } from "vitest";
import { resumeProject } from "../../scripts/resume-supabase.mjs";

const projectRef = "abcdefghijklmnopqrst";
const token = "dummy-secret-not-for-logs";
const project = (status: string) => ({ ref: projectRef, status });
const healthy = () => ["db", "auth", "rest", "storage"].map((name) => ({ name, status: "ACTIVE_HEALTHY" }));

function harness(responses: (object | Response | Error)[]) {
  let clock = 0;
  const fetchImpl = vi.fn(async () => {
    const response = responses.shift();
    if (response instanceof Error) throw response;
    if (response instanceof Response) return response;
    if (response === undefined) throw new Error("Unexpected request");
    return Response.json(response);
  });
  const log = vi.fn();
  const run = () => resumeProject({
    token, projectRef, fetchImpl, log,
    now: () => clock,
    sleep: async (ms: number) => { clock += ms; },
    timeoutMs: 30, pollMs: 10,
  });
  return { run, fetchImpl, log };
}

describe("manual Supabase resume", () => {
  it("resumes a paused project once and waits for all required services", async () => {
    const pending = healthy().map((service) => ({ ...service, status: "COMING_UP" }));
    const { run, fetchImpl, log } = harness([
      project("INACTIVE"), {}, project("RESTORING"),
      project("ACTIVE_HEALTHY"), pending, project("ACTIVE_HEALTHY"), healthy(),
    ]);
    await run();
    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    expect(calls.filter(([, options]) => options.method === "POST")).toEqual([
      [`https://api.supabase.com/v1/projects/${projectRef}/restore`, expect.objectContaining({
        method: "POST", redirect: "error", headers: { Authorization: `Bearer ${token}` },
      })],
    ]);
    expect(log.mock.calls.flat().join(" ")).not.toContain(token);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("No migration or deployment"));
  });

  it.each(["ACTIVE_HEALTHY", "RESTORING", "COMING_UP"])("does not issue resume for %s", async (status) => {
    const { run, fetchImpl } = harness([project(status), project("ACTIVE_HEALTHY"), healthy()]);
    await run();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ method: "POST" }));
  });

  it.each(["ACTIVE_UNHEALTHY", "PAUSING", "PAUSE_FAILED", "RESTARTING", "RESTORE_FAILED", "UNKNOWN", "REMOVED"])("fails safely for initial %s", async (status) => {
    const { run, fetchImpl } = harness([project(status)]);
    await expect(run()).rejects.toThrow("resume was not requested");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry a rejected restore or print its response body", async () => {
    const { run, fetchImpl } = harness([project("INACTIVE"), new Response(token, { status: 403 })]);
    await expect(run()).rejects.toThrow("HTTP 403");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry a restore with an unknown network outcome or expose its error", async () => {
    const { run, fetchImpl } = harness([project("INACTIVE"), new Error(token)]);
    await expect(run()).rejects.toThrow("network or timeout");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fails on a restoration failure without a second POST", async () => {
    const { run, fetchImpl } = harness([project("INACTIVE"), {}, project("RESTORE_FAILED")]);
    await expect(run()).rejects.toThrow("entered RESTORE_FAILED");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it.each([[], healthy().slice(0, 3), healthy().map((service) => ({ ...service, status: "UNHEALTHY" }))].map((services) => [services]))("never accepts missing or unhealthy services", async (services) => {
    const { run } = harness([
      project("ACTIVE_HEALTHY"), project("ACTIVE_HEALTHY"), services,
      project("ACTIVE_HEALTHY"), services, project("ACTIVE_HEALTHY"), services,
    ]);
    await expect(run()).rejects.toThrow("Timed out");
  });

  it("rejects a different project before any restore", async () => {
    const { run, fetchImpl } = harness([{ ref: "different-project", status: "INACTIVE" }]);
    await expect(run()).rejects.toThrow("unexpected project");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects missing configuration before making requests", async () => {
    const fetchImpl = vi.fn();
    await expect(resumeProject({ token: undefined, projectRef, fetchImpl })).rejects.toThrow("missing or invalid");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
