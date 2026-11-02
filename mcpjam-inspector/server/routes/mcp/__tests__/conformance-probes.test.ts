import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const { runProtocolConformanceMock } = vi.hoisted(() => ({
  runProtocolConformanceMock: vi.fn(),
}));

vi.mock("../../shared/conformance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/conformance")>()),
  runProtocolConformance: runProtocolConformanceMock,
}));

import conformance from "../conformance.js";

function createTestApp() {
  const app = new Hono();
  app.use("*", async (c, next) => {
    (c as any).mcpClientManager = {
      getServerConfig: vi
        .fn()
        .mockReturnValue({ url: new URL("https://example.test/mcp") }),
      getConnectionStatus: vi.fn().mockReturnValue("connected"),
    };
    await next();
  });
  app.route("/api/mcp/conformance", conformance);
  return app;
}

function postProtocol(body: Record<string, unknown>) {
  return createTestApp().request("/api/mcp/conformance/protocol", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverId: "test-server", ...body }),
  });
}

beforeEach(() => {
  runProtocolConformanceMock.mockReset();
  runProtocolConformanceMock.mockResolvedValue({
    result: { passed: true, checks: [] },
  });
});

describe("POST /api/mcp/conformance/protocol probe tools", () => {
  it("forwards the named probe tools to the protocol run", async () => {
    const res = await postProtocol({
      logProbe: { toolName: "emit-logs", arguments: { count: 2 } },
      inputRequiredProbe: { toolName: "ask-user" },
    });

    expect(res.status).toBe(200);
    expect(runProtocolConformanceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        serverUrl: "https://example.test/mcp",
        logProbe: { toolName: "emit-logs", arguments: { count: 2 } },
        inputRequiredProbe: { toolName: "ask-user" },
      }),
    );
  });

  it("runs without probes when none are named", async () => {
    await postProtocol({});
    const input = runProtocolConformanceMock.mock.calls[0]![0];
    expect(input.logProbe).toBeUndefined();
    expect(input.inputRequiredProbe).toBeUndefined();
  });

  it.each([
    ["an empty tool name", { logProbe: { toolName: "  " } }],
    ["an unknown key", { logProbe: { toolName: "emit-logs", tool: "x" } }],
    [
      "arguments that are not an object",
      { inputRequiredProbe: { toolName: "ask-user", arguments: [1, 2] } },
    ],
  ])("rejects a probe with %s before running anything", async (_name, body) => {
    const res = await postProtocol(body);
    expect(res.status).toBe(400);
    expect((await res.json()).success).toBe(false);
    expect(runProtocolConformanceMock).not.toHaveBeenCalled();
  });
});
