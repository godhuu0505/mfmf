import { describe, expect, it, vi } from "vitest";
import { environmentMetadata, inspectEnvironment } from "../../scripts/gcp/inspect-vercel-environment.mjs";

const env = {
  GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "workflow_dispatch",
  VERCEL_TOKEN: "fixture-token-never-print", VERCEL_ORG_ID: "team_fixture", VERCEL_PROJECT_ID: "prj_fixture",
};

describe("Vercel environment metadata inspection", () => {
  it("reports fixed metadata for every allowed key without any values or arbitrary strings", () => {
    const privateData = "private-fixture-never-print";
    const result = environmentMetadata({
      envs: [
        { key: "GOOGLE_CLIENT_SECRET", type: "sensitive", visibility: "secret", value: privateData,
          target: ["production"], id: privateData, sunsetSecretId: privateData, decrypted: false },
        { key: "TOKEN_ENC_KEY", type: privateData, visibility: privateData, value: { nested: privateData },
          target: "preview", gitBranch: privateData, decrypted: privateData },
        { key: privateData, type: "plain", value: privateData, target: "production" },
      ], pagination: { next: privateData }, hiddenProductionEnvCount: 1,
    });
    expect(result.hasNextPage).toBe(true);
    expect(result.hiddenProductionEntries).toBe(true);
    expect(result.settings).toHaveLength(9);
    expect(result.settings.find((row) => row.key === "GOOGLE_CLIENT_SECRET")?.entries).toEqual([
      { production: true, scopeKnown: true, branchSpecific: false, type: "sensitive", visibility: "secret",
        decryptedPresent: true, decryptedType: "boolean", decrypted: false, valuePresent: true,
        valueType: "string", legacySecretMigration: true },
    ]);
    expect(JSON.stringify(result)).not.toContain(privateData);
    expect(JSON.stringify(result)).not.toContain(env.VERCEL_TOKEN);
    expect(result.settings.find((row) => row.key === "SENTRY_DSN")?.entries).toEqual([]);
  });

  it("preserves missing, duplicate and ambiguous metadata as evidence rather than assuming readability", () => {
    const result = environmentMetadata({ envs: [
      { key: "TOKEN_ENC_KEY", type: "secret" },
      { key: "TOKEN_ENC_KEY", type: "encrypted", target: ["production"], value: null },
    ] });
    const entries = result.settings.find((row) => row.key === "TOKEN_ENC_KEY")!.entries;
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ scopeKnown: false, visibility: "absent", valuePresent: false, decryptedType: "undefined" });
    expect(entries[1]).toMatchObject({ production: true, valueType: "null" });
    expect(result.hiddenProductionEntries).toBe("unknown");
  });

  it("makes exactly one GET to the fixed API with redirects denied", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ envs: [] }));
    await inspectEnvironment({ env, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith("https://api.vercel.com/v10/projects/prj_fixture/env?teamId=team_fixture", {
      method: "GET", headers: { Authorization: `Bearer ${env.VERCEL_TOKEN}` },
      redirect: "error", signal: expect.any(AbortSignal),
    });
  });

  it.each(["wrong-ref", "wrong-event", "not-actions", "missing-token"])("refuses %s before any request", async (failure) => {
    const invalid = { ...env };
    if (failure === "wrong-ref") invalid.GITHUB_REF = "refs/heads/feature";
    if (failure === "wrong-event") invalid.GITHUB_EVENT_NAME = "pull_request";
    if (failure === "not-actions") invalid.GITHUB_ACTIONS = "false";
    if (failure === "missing-token") invalid.VERCEL_TOKEN = "";
    const fetchImpl = vi.fn();
    await expect(inspectEnvironment({ env: invalid, fetchImpl })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["http", "network", "json", "shape"])("withholds private %s failure details", async (failure) => {
    const privateData = "private-fixture-never-print";
    const fetchImpl = vi.fn(async () => {
      if (failure === "network") throw new Error(privateData);
      if (failure === "http") return new Response(privateData, { status: 403 });
      if (failure === "json") return new Response(privateData);
      return Response.json({ error: privateData });
    });
    const error = await inspectEnvironment({ env, fetchImpl }).then(() => null, (value: Error) => value);
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).not.toContain(privateData);
    expect(error?.message).not.toContain(env.VERCEL_TOKEN);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
