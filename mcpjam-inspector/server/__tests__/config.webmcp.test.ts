import { afterEach, describe, expect, it, vi } from "vitest";

const HOSTED_ENV = "VITE_MCPJAM_HOSTED_MODE";
const ENABLED_ENV = "MCPJAM_WEBMCP_INSPECTOR_ENABLED";
const HOSTED_GATE_ENV = "MCPJAM_WEBMCP_INSPECTOR_HOSTED_ENABLED";
const BROWSER_TOOLS_ENV = "HOSTED_BROWSER_TOOLS_ENABLED";
const originalEnv = {
  hosted: process.env[HOSTED_ENV],
  enabled: process.env[ENABLED_ENV],
  hostedGate: process.env[HOSTED_GATE_ENV],
  browserTools: process.env[BROWSER_TOOLS_ENV],
};

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

interface WebMcpEnv {
  hosted?: string;
  enabled?: string;
  hostedGate?: string;
  browserTools?: string;
}

async function loadConfig(env: WebMcpEnv) {
  setEnv(HOSTED_ENV, env.hosted);
  setEnv(ENABLED_ENV, env.enabled);
  setEnv(HOSTED_GATE_ENV, env.hostedGate);
  setEnv(BROWSER_TOOLS_ENV, env.browserTools);
  vi.resetModules();
  return await import("../config");
}

async function loadWebMcpEnabled(env: WebMcpEnv): Promise<boolean> {
  return (await loadConfig(env)).WEBMCP_INSPECTOR_ENABLED;
}

describe("WEBMCP_INSPECTOR_ENABLED", () => {
  afterEach(() => {
    setEnv(HOSTED_ENV, originalEnv.hosted);
    setEnv(ENABLED_ENV, originalEnv.enabled);
    setEnv(HOSTED_GATE_ENV, originalEnv.hostedGate);
    setEnv(BROWSER_TOOLS_ENV, originalEnv.browserTools);
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
    // Hosted reachability is a separate gate, below.
    await expect(loadWebMcpEnabled({ hosted: "true" })).resolves.toBe(true);
    await expect(
      loadWebMcpEnabled({ hosted: "true", enabled: "false" }),
    ).resolves.toBe(false);
  });
});

describe("webmcpInspectorHostedEnabled", () => {
  afterEach(() => {
    setEnv(HOSTED_ENV, originalEnv.hosted);
    setEnv(ENABLED_ENV, originalEnv.enabled);
    setEnv(HOSTED_GATE_ENV, originalEnv.hostedGate);
    setEnv(BROWSER_TOOLS_ENV, originalEnv.browserTools);
  });

  it("is off by default, even in hosted mode", async () => {
    const config = await loadConfig({ hosted: "true" });
    expect(config.webmcpInspectorHostedEnabled()).toBe(false);
  });

  it("turns on with its own variable", async () => {
    const config = await loadConfig({ hosted: "true", hostedGate: "1" });
    expect(config.webmcpInspectorHostedEnabled()).toBe(true);
  });

  it("means nothing on a local inspector", async () => {
    // Local reachability is `/api/mcp/webmcp`, which needs no hosted gate.
    const config = await loadConfig({ hostedGate: "1" });
    expect(config.webmcpInspectorHostedEnabled()).toBe(false);
  });

  it("is INDEPENDENT of the browser-tools switch, in both directions", async () => {
    // The separation is the point. Both switches lead to the same hosted
    // browser, but one lets a person drive their own page and the other hands
    // six tools to a model — with co-tenancy and approval threading behind it.
    // Sharing a variable would make turning on the first turn on the second.
    const inspectorOnly = await loadConfig({
      hosted: "true",
      hostedGate: "1",
    });
    expect(inspectorOnly.webmcpInspectorHostedEnabled()).toBe(true);
    expect(inspectorOnly.hostedBrowserEnabled()).toBe(false);

    const toolsOnly = await loadConfig({
      hosted: "true",
      browserTools: "1",
    });
    expect(toolsOnly.webmcpInspectorHostedEnabled()).toBe(false);
    expect(toolsOnly.hostedBrowserEnabled()).toBe(true);
  });

  it("reads the environment at CALL time, not at import", async () => {
    // Flipped per-process on staging and per-test; a module constant would
    // freeze whatever the environment said when the module first loaded.
    const config = await loadConfig({ hosted: "true" });
    expect(config.webmcpInspectorHostedEnabled()).toBe(false);
    setEnv(HOSTED_GATE_ENV, "1");
    expect(config.webmcpInspectorHostedEnabled()).toBe(true);
  });
});
