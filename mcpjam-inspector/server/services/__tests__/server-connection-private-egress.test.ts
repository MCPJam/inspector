import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProbeMcpServerConfig, ProbeMcpServerResult } from "@mcpjam/sdk";

vi.mock("../../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config.js")>()),
  HOSTED_MODE: true,
}));

const { runDiscoveryPreflight } = await import(
  "../server-connection-discovery.js"
);

afterEach(() => vi.unstubAllEnvs());

function ready(config: ProbeMcpServerConfig): Promise<ProbeMcpServerResult> {
  return Promise.resolve({
    url: config.url,
    protocolVersion: "2025-11-25",
    status: "ready",
    transport: { attempts: [] },
    oauth: { required: false, optional: false, registrationStrategies: [] },
  });
}

describe("hosted private MCP discovery", () => {
  it("probes an operator-admitted literal without granting general private OAuth discovery", async () => {
    vi.stubEnv("MCPJAM_PRIVATE_EGRESS_ALLOWLIST", "10.0.0.0/8");
    const probeServer = vi.fn(ready);
    const outcome = await runDiscoveryPreflight(
      { serverUrl: "https://10.0.0.5/mcp" },
      { probeServer },
    );
    expect(outcome).toMatchObject({ kind: "discovered", authMethod: "none" });
    expect(probeServer).toHaveBeenCalledWith(
      expect.objectContaining({
        allowPrivateNetwork: false,
      }),
    );
  });

  it.each([
    ["10.0.0.0/8", "https://192.168.1.5/mcp"],
    ["0.0.0.0/0", "https://169.254.169.254/latest/meta-data/"],
    ["invalid/entry", "https://10.0.0.5/mcp"],
    ["", "https://10.0.0.5/mcp"],
    ["10.0.0.0/8", "http://10.0.0.5/mcp"],
  ])("refuses %s / %s before probing", async (allowlist, serverUrl) => {
    vi.stubEnv("MCPJAM_PRIVATE_EGRESS_ALLOWLIST", allowlist);
    const probeServer = vi.fn(ready);
    const outcome = await runDiscoveryPreflight({ serverUrl }, { probeServer });
    expect(outcome).toMatchObject({
      kind: "terminal",
      errorCode: "URL_NOT_ALLOWED",
    });
    expect(probeServer).not.toHaveBeenCalled();
  });
});
