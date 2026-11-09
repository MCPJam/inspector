import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MCPClientManager } from "@mcpjam/sdk";
import type { McpAppBrowserHarness } from "../mcp-app-browser-harness";

// HOSTED_MODE is a module-load-time const, so it is mocked before importing
// the module under test; the getter lets each test pick hosted or local.
const { mode, systemEvent } = vi.hoisted(() => ({
  mode: { hosted: false },
  systemEvent: vi.fn(),
}));

vi.mock("../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config.js")>();
  return {
    ...actual,
    get HOSTED_MODE() {
      return mode.hosted;
    },
  };
});

vi.mock("../request-logger.js", () => ({
  getSystemLogger: vi.fn(() => ({ event: systemEvent })),
}));

const { renderMcpAppToolResult } = await import(
  "../mcp-app-render-observation"
);

async function renderWithFailedRead(error: Error) {
  return renderMcpAppToolResult({
    toolCallId: "tc",
    toolName: "t",
    serverId: "s",
    toolMetadata: { ui: { resourceUri: "ui://widget/seats" } },
    mcpClientManager: {
      readResource: vi.fn().mockRejectedValue(error),
    } as unknown as MCPClientManager,
    harness: { renderWidget: vi.fn() } as unknown as McpAppBrowserHarness,
  });
}

describe("renderMcpAppToolResult — resource read failure alert", () => {
  beforeEach(() => {
    systemEvent.mockClear();
  });

  it("sends the failure to Sentry on the hosted server", async () => {
    mode.hosted = true;
    const error = new Error("read timed out");

    const obs = await renderWithFailedRead(error);

    expect(obs.status).toBe("resource_read_failed");
    expect(systemEvent).toHaveBeenCalledWith(
      "mcp_app.resource_read.failed",
      { durationMs: expect.any(Number) },
      { error, sentry: true },
    );
  });

  it("records the failure without Sentry on a local install", async () => {
    mode.hosted = false;
    const error = new Error("read timed out");

    const obs = await renderWithFailedRead(error);

    expect(obs.status).toBe("resource_read_failed");
    expect(systemEvent).toHaveBeenCalledWith(
      "mcp_app.resource_read.failed",
      { durationMs: expect.any(Number) },
      { error, sentry: false },
    );
  });
});
