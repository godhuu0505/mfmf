import { describe, expect, it, vi } from "vitest";
import { classifyValidation, diagnoseProject } from "../../scripts/diagnose-supabase-health.mjs";

const token = "test-private-token-never-log";
const projectRef = "abcdefghijklmnopqrst";
const bodySecret = "private-response-value-never-log";
const names = ["db", "auth", "rest", "storage"];
const healthy = (services = names) => services.map((name) => ({ name, status: "ACTIVE_HEALTHY", error: bodySecret, info: { version: bodySecret } }));
const status = (state = "ACTIVE_HEALTHY") => Response.json({ ref: projectRef, status: state, database: { password: bodySecret } });

function harness(handler: (url: URL) => Response | Promise<Response> = (url) => {
  const requested = url.searchParams.getAll("services").flatMap((value) => value.split(","));
  return requested.length ? Response.json(healthy(requested)) : status();
}) {
  const fetchImpl = vi.fn(async (url: Parameters<typeof fetch>[0], options?: RequestInit) => {
    expect(options?.method).toBe("GET");
    expect(options?.redirect).toBe("error");
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(options?.headers).toEqual({ Authorization: `Bearer ${token}` });
    expect(new URL(String(url)).origin).toBe("https://api.supabase.com");
    return handler(new URL(String(url)));
  });
  const log = vi.fn();
  const run = () => diagnoseProject({ token, projectRef, fetchImpl, log });
  const exposed = () => JSON.stringify(log.mock.calls);
  return { run, fetchImpl, log, exposed };
}

describe("GET-only Supabase health diagnosis", () => {
  it("compares documented query forms with exactly eight GETs and emits only sanitized results", async () => {
    const { run, fetchImpl, exposed } = harness();
    const result = await run();
    expect(result.allServicesHealthy).toBe(true);
    expect(result.allQueriesAccepted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(8);
    const queries = fetchImpl.mock.calls.slice(1).map(([url]) => new URL(String(url)).search);
    expect(queries).toEqual([
      "?services=db&services=auth&services=rest&services=storage&timeout_ms=5000",
      "?services=db&services=auth&services=rest&services=storage",
      "?services=db%2Cauth%2Crest%2Cstorage",
      ...names.map((name) => `?services=${name}`),
    ]);
    for (const secret of [token, projectRef, bodySecret]) {
      expect(exposed()).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });

  it("identifies timeout validation without leaking API messages or abandoning the fixed comparison", async () => {
    const { run, exposed } = harness((url) => {
      if (!url.pathname.endsWith("/health")) return status();
      if (url.searchParams.has("timeout_ms")) return Response.json({
        message: [`timeout_ms must be an integer number: ${bodySecret}`],
        errors: [{ path: ["timeout_ms"], code: "invalid_type", message: bodySecret, received: token }],
      }, { status: 400 });
      return Response.json(healthy());
    });
    const result = await run();
    expect(result.allServicesHealthy).toBe(true);
    expect(result.allQueriesAccepted).toBe(false);
    expect(result.probes[0]).toMatchObject({ httpStatus: 400, outcome: "http-error", validation: { parameters: ["timeout_ms"], codes: ["invalid_type"] } });
    expect(exposed()).not.toContain(bodySecret);
    expect(exposed()).not.toContain(token);
  });

  it("can verify all four services through independent single-service responses", async () => {
    const { run } = harness((url) => {
      if (!url.pathname.endsWith("/health")) return status();
      const requested = url.searchParams.getAll("services");
      if (requested.length > 1 || requested[0].includes(",")) return Response.json({ message: "services must be an array" }, { status: 400 });
      return Response.json(healthy(requested));
    });
    const result = await run();
    expect(result.allServicesHealthy).toBe(true);
    expect(result.allQueriesAccepted).toBe(false);
  });

  it.each([[], healthy().slice(0, 3), healthy().concat(healthy(["db"])), healthy().map((item) => ({ ...item, status: "UNHEALTHY" })), [{ name: bodySecret, status: "ACTIVE_HEALTHY" }]].map((response) => ({ response })))("does not claim full health for missing, duplicate, unhealthy or unknown service data", async ({ response }) => {
    const { run, exposed } = harness((url) => url.pathname.endsWith("/health") ? Response.json(response) : status());
    const result = await run();
    expect(result.allServicesHealthy).toBe(false);
    expect(exposed()).not.toContain(bodySecret);
  });

  it.each(["INACTIVE", "ACTIVE_UNHEALTHY", "RESTORING"])("never attempts to restore a project in %s", async (state) => {
    const { run, fetchImpl } = harness(() => status(state));
    expect((await run()).projectReady).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("stops before health probes on a different project or access failure", async () => {
    for (const response of [Response.json({ ref: "wrong-project", status: "ACTIVE_HEALTHY", password: bodySecret }), new Response(bodySecret, { status: 403 }), new Response(null, { status: 302, headers: { Location: `https://example.invalid/${token}` } })]) {
      const { run, fetchImpl, exposed } = harness(() => response);
      expect((await run()).allServicesHealthy).toBe(false);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(exposed()).not.toContain(bodySecret);
      expect(exposed()).not.toContain(token);
    }
  });

  it("bounds and discards oversized error responses", async () => {
    const { run, exposed } = harness((url) => url.pathname.endsWith("/health")
      ? Response.json({ message: bodySecret.repeat(2000) }, { status: 400 }) : status());
    const result = await run();
    expect(result.probes.every((probe) => "bodyKind" in probe && probe.bodyKind === "body-too-large")).toBe(true);
    expect(exposed()).not.toContain(bodySecret);
  });

  it("withholds network errors, malformed JSON and primitive successful bodies", async () => {
    for (const reply of [() => { throw new Error(`${token} ${bodySecret}`); }, () => new Response(bodySecret), () => Response.json(bodySecret), () => Response.json(null), () => Response.json(0)]) {
      const { run, exposed } = harness((url) => url.pathname.endsWith("/health") ? reply() : status());
      expect((await run()).allServicesHealthy).toBe(false);
      expect(exposed()).not.toContain(token);
      expect(exposed()).not.toContain(bodySecret);
      expect(exposed()).not.toContain('"body":');
    }
  });

  it("rejects invalid configuration without making a request", async () => {
    const fetchImpl = vi.fn();
    await expect(diagnoseProject({ token: undefined, projectRef, fetchImpl })).rejects.toThrow("missing or invalid");
    await expect(diagnoseProject({ token, projectRef: `${projectRef}/restore`, fetchImpl })).rejects.toThrow("missing or invalid");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("extracts only whitelisted parameter names and validation codes", () => {
    const result = classifyValidation({
      errors: [
        { path: ["query", "services", bodySecret], code: "invalid_union", message: token },
        { property: "timeout_ms", constraints: { isInt: `timeout_ms must be an integer number (${bodySecret})` } },
        { path: [token], property: bodySecret, code: bodySecret, message: bodySecret },
      ],
    });
    expect(result).toEqual({ parameters: ["services", "timeout_ms"], codes: ["invalid_type", "invalid_union"] });
    expect(JSON.stringify(result)).not.toContain(bodySecret);
    expect(JSON.stringify(result)).not.toContain(token);
  });
});
