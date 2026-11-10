import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ErrorOrigin, MCPClientManager } from "@mcpjam/sdk";
import type { McpAppBrowserHarness } from "../mcp-app-browser-harness";

// HOSTED_MODE is a module-load-time const, so it is mocked before importing
// the module under test; the getters let each test pick hosted or local and
// whose fault the read error is.
const { mode, systemEvent } = vi.hoisted(() => ({
  mode: { hosted: false, origin: "ambiguous" as ErrorOrigin },
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

vi.mock("@mcpjam/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mcpjam/sdk")>();
  return {
    ...actual,
    describeError: vi.fn(() => ({ origin: mode.origin })),
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

  it("sends an error of ours to Sentry on the hosted server", async () => {
    mode.hosted = true;
    mode.origin = "mcpjam";
    const error = new Error("read failed");

    const obs = await renderWithFailedRead(error);

    expect(obs.status).toBe("resource_read_failed");
    expect(systemEvent).toHaveBeenCalledWith(
      "mcp_app.resource_read.failed",
      { durationMs: expect.any(Number), origin: "mcpjam" },
      { error, sentry: true },
    );
  });

  it("keeps a user server's timeout out of Sentry on the hosted server", async () => {
    mode.hosted = true;
    mode.origin = "ambiguous";
    const error = new Error("read timed out");

    await renderWithFailedRead(error);

    expect(systemEvent).toHaveBeenCalledWith(
      "mcp_app.resource_read.failed",
      { durationMs: expect.any(Number), origin: "ambiguous" },
      { error, sentry: false },
    );
  });

  it("records an error of ours without Sentry on a local install", async () => {
    mode.hosted = false;
    mode.origin = "mcpjam";
    const error = new Error("read failed");

    const obs = await renderWithFailedRead(error);

    expect(obs.status).toBe("resource_read_failed");
    expect(systemEvent).toHaveBeenCalledWith(
      "mcp_app.resource_read.failed",
      { durationMs: expect.any(Number), origin: "mcpjam" },
      { error, sentry: false },
    );
  });
});
