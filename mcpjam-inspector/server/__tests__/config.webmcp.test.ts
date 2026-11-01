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
  return (await import("../config")).WEBMCP_INSPECTOR_ENABLED;
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

  it("is the kill switch in BOTH modes now, not a local-only one", async () => {
    // It used to force off under hosted, because the browser ran on the
    // machine running the inspector. A hosted session does not open a browser
    // here at all — it drives one on the member's own computer — so WHERE the
    // browser runs is a per-session decision and this is just the off switch.
    // Who may start a hosted one is the backend's `hosted-browser` gate.
    await expect(loadWebMcpEnabled({ hosted: "true" })).resolves.toBe(true);
    await expect(
      loadWebMcpEnabled({ hosted: "true", enabled: "false" }),
    ).resolves.toBe(false);
  });
});
