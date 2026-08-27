import { afterEach, describe, expect, it, vi } from "vitest";

const HOSTED_ENV = "VITE_MCPJAM_HOSTED_MODE";
const ENABLED_ENV = "MCPJAM_WEBMCP_INSPECTOR_ENABLED";
const originalEnv = {
  hosted: process.env[HOSTED_ENV],
  enabled: process.env[ENABLED_ENV],
};

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function loadWebMcpEnabled(env: {
  hosted?: string;
  enabled?: string;
}): Promise<boolean> {
  setEnv(HOSTED_ENV, env.hosted);
  setEnv(ENABLED_ENV, env.enabled);
  vi.resetModules();
  const config = await import("../config");
  return config.WEBMCP_INSPECTOR_ENABLED;
}

describe("WEBMCP_INSPECTOR_ENABLED", () => {
  afterEach(() => {
    setEnv(HOSTED_ENV, originalEnv.hosted);
    setEnv(ENABLED_ENV, originalEnv.enabled);
  });

  it("defaults on for a local inspector", async () => {
    await expect(loadWebMcpEnabled({})).resolves.toBe(true);
  });

  it("honors the local emergency kill switch", async () => {
    await expect(loadWebMcpEnabled({ enabled: "false" })).resolves.toBe(false);
  });

  it("stays off in hosted mode even when explicitly enabled", async () => {
    await expect(
      loadWebMcpEnabled({ hosted: "true", enabled: "true" }),
    ).resolves.toBe(false);
  });
});
