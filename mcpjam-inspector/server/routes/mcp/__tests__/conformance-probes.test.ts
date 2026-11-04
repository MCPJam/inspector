import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const {
  runProtocolConformanceMock,
  runTasksConformanceMock,
  startOAuthConformanceMock,
} = vi.hoisted(() => ({
  runProtocolConformanceMock: vi.fn(),
  runTasksConformanceMock: vi.fn(),
  startOAuthConformanceMock: vi.fn(),
}));

vi.mock("../../shared/conformance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/conformance")>()),
  runProtocolConformance: runProtocolConformanceMock,
  runTasksConformance: runTasksConformanceMock,
  startOAuthConformance: startOAuthConformanceMock,
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
      logProbe: {
        toolName: "emit-logs",
        arguments: { count: 2 },
        level: "info",
      },
      inputRequiredProbe: { toolName: "ask-user" },
      toolCallProbe: { toolName: "weather" },
    });

    expect(res.status).toBe(200);
    expect(runProtocolConformanceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        serverUrl: "https://example.test/mcp",
        logProbe: {
          toolName: "emit-logs",
          arguments: { count: 2 },
          level: "info",
        },
        inputRequiredProbe: { toolName: "ask-user" },
        toolCallProbe: { toolName: "weather" },
      }),
    );
  });

  it("runs without probes when none are named", async () => {
    await postProtocol({});
    const input = runProtocolConformanceMock.mock.calls[0]![0];
    expect(input.logProbe).toBeUndefined();
    expect(input.inputRequiredProbe).toBeUndefined();
    expect(input.toolCallProbe).toBeUndefined();
  });

  it.each([
    ["an empty tool name", { logProbe: { toolName: "  " } }],
    ["an unknown key", { logProbe: { toolName: "emit-logs", tool: "x" } }],
    [
      "an unknown log level",
      { logProbe: { toolName: "emit-logs", level: "loud" } },
    ],
    [
      "a log level on the input probe",
      { inputRequiredProbe: { toolName: "ask-user", level: "info" } },
    ],
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

describe("POST /api/mcp/conformance/protocol advice picks", () => {
  it("forwards the picked advice, an empty list included", async () => {
    await postProtocol({ readinessIds: ["readiness-log-level-filtering"] });
    await postProtocol({ readinessIds: [] });
    await postProtocol({});

    const inputs = runProtocolConformanceMock.mock.calls.map(
      (call) => call[0].readinessIds,
    );
    expect(inputs).toEqual([["readiness-log-level-filtering"], [], undefined]);
  });

  it("rejects an unknown advice id before running anything", async () => {
    const res = await postProtocol({ readinessIds: ["readiness-made-up"] });
    expect(res.status).toBe(400);
    expect(runProtocolConformanceMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/mcp/conformance tasks and oauth advice picks", () => {
  function post(path: string, body: Record<string, unknown>) {
    return createTestApp().request(`/api/mcp/conformance/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverId: "test-server", ...body }),
    });
  }

  beforeEach(() => {
    runTasksConformanceMock.mockReset();
    runTasksConformanceMock.mockResolvedValue({ result: { checks: [] } });
    startOAuthConformanceMock.mockReset();
    startOAuthConformanceMock.mockResolvedValue({ phase: "complete" });
  });

  it("forwards the picked Tasks advice", async () => {
    await post("tasks", {
      readinessIds: ["tasks-readiness-failed-status-message"],
    });
    expect(runTasksConformanceMock.mock.calls[0]![0].readinessIds).toEqual([
      "tasks-readiness-failed-status-message",
    ]);
  });

  it("forwards the picked OAuth advice, an empty list included", async () => {
    await post("oauth/start", {
      callbackOrigin: "http://localhost:5173",
      readinessIds: [],
    });
    expect(startOAuthConformanceMock.mock.calls[0]![0].readinessIds).toEqual(
      [],
    );
  });

  it.each([
    ["tasks", { readinessIds: ["readiness-log-level-filtering"] }],
    [
      "oauth/start",
      {
        callbackOrigin: "http://localhost:5173",
        readinessIds: ["tasks-readiness-failed-status-message"],
      },
    ],
  ])("rejects another suite's advice id on %s", async (path, body) => {
    const res = await post(path, body);
    expect(res.status).toBe(400);
    expect(runTasksConformanceMock).not.toHaveBeenCalled();
    expect(startOAuthConformanceMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/mcp/conformance/tasks task tool", () => {
  function postTasks(body: Record<string, unknown>) {
    return createTestApp().request("/api/mcp/conformance/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverId: "test-server", ...body }),
    });
  }

  beforeEach(() => {
    runTasksConformanceMock.mockReset();
    runTasksConformanceMock.mockResolvedValue({ result: { checks: [] } });
  });

  it("forwards complete per-check overrides", async () => {
    const checkOverrides = {
      "tasks-inline-result": {
        toolName: "finish",
        toolArguments: { fast: true },
      },
    };
    expect(
      (await postTasks({ toolName: "default", checkOverrides })).status,
    ).toBe(200);
    expect(runTasksConformanceMock).toHaveBeenCalledWith(
      expect.objectContaining({ checkOverrides }),
    );
  });
  it.each([
    { unknown: { toolName: "job" } },
    { "tasks-wire-resolvable": { toolName: "job" } },
    { "tasks-inline-result": { toolName: "job", toolArguments: [] } },
  ])("rejects malformed task overrides", async (checkOverrides) => {
    expect((await postTasks({ checkOverrides })).status).toBe(400);
    expect(runTasksConformanceMock).not.toHaveBeenCalled();
  });

  it("forwards the tool, its arguments and the input answers", async () => {
    const inputResponses = {
      confirm: { action: "accept", content: { ok: true } },
    };
    const res = await postTasks({
      toolName: "long-job",
      toolArguments: { seconds: 2 },
      inputResponses,
    });

    expect(res.status).toBe(200);
    expect(runTasksConformanceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "long-job",
        toolArguments: { seconds: 2 },
        inputResponses,
      }),
    );
  });

  it.each([
    ["answers that are not an object", { inputResponses: ["yes"] }],
    [
      "answers over the size cap",
      { inputResponses: { confirm: "x".repeat(10_001) } },
    ],
  ])("rejects %s", async (_label, body) => {
    const res = await postTasks({ toolName: "long-job", ...body });
    expect(res.status).toBe(400);
    expect(runTasksConformanceMock).not.toHaveBeenCalled();
  });
});
