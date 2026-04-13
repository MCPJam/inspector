import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  convexQueryMock,
  captureToolSnapshotForEvalAuthoringMock,
  fetchReplayConfigMock,
  storeReplayConfigMock,
  startSuiteRunWithRecorderMock,
  runEvalSuiteWithAiSdkMock,
  disconnectAllServersMock,
} = vi.hoisted(() => ({
  convexQueryMock: vi.fn(),
  captureToolSnapshotForEvalAuthoringMock: vi.fn(),
  fetchReplayConfigMock: vi.fn(),
  storeReplayConfigMock: vi.fn(),
  startSuiteRunWithRecorderMock: vi.fn(),
  runEvalSuiteWithAiSdkMock: vi.fn(),
  disconnectAllServersMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@mcpjam/sdk", async () => {
  const actual =
    await vi.importActual<typeof import("@mcpjam/sdk")>("@mcpjam/sdk");
  return {
    ...actual,
    MCPClientManager: vi.fn(() => ({
      disconnectAllServers: disconnectAllServersMock,
    })),
  };
});

vi.mock("../../../services/evals/route-helpers.js", () => ({
  buildReplayManager: vi.fn(() => ({
    disconnectAllServers: disconnectAllServersMock,
    connectToServer: vi.fn().mockResolvedValue(undefined),
    getConnectionStatus: vi.fn(() => "connected"),
    getToolsForAiSdk: vi.fn().mockResolvedValue({}),
  })),
  connectReplayManagerServers: vi.fn().mockResolvedValue(undefined),
  createConvexClient: vi.fn(() => ({
    query: convexQueryMock,
  })),
  captureToolSnapshotForEvalAuthoring: (...args: unknown[]) =>
    captureToolSnapshotForEvalAuthoringMock(...args),
  fetchReplayConfig: (...args: unknown[]) => fetchReplayConfigMock(...args),
  requireConvexHttpUrl: vi.fn(() => "https://convex.example"),
  storeReplayConfig: (...args: unknown[]) => storeReplayConfigMock(...args),
}));

vi.mock("../../../services/evals/recorder", () => ({
  startSuiteRunWithRecorder: (...args: unknown[]) =>
    startSuiteRunWithRecorderMock(...args),
}));

vi.mock("../../../services/evals-runner", () => ({
  runEvalSuiteWithAiSdk: (...args: unknown[]) =>
    runEvalSuiteWithAiSdkMock(...args),
}));

import evalsRoutes from "../evals";

function createApp() {
  const app = new Hono();
  app.route("/api/mcp/evals", evalsRoutes);
  return app;
}

describe("mcp replay route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    convexQueryMock.mockResolvedValue({
      suiteId: "suite-1",
      hasServerReplayConfig: true,
      environment: { servers: ["srv_asana"] },
    });
    fetchReplayConfigMock.mockResolvedValue({
      runId: "source-run",
      suiteId: "suite-1",
      servers: [
        {
          serverId: "excalidraw",
          url: "https://mcp.excalidraw.com",
        },
      ],
    });
    captureToolSnapshotForEvalAuthoringMock.mockResolvedValue({
      toolSnapshot: {
        version: 1,
        capturedAt: 123,
        servers: [
          {
            serverId: "excalidraw",
            tools: [
              {
                name: "search",
                description: "Find drawings.",
                inputSchema: { type: "object" },
              },
            ],
          },
        ],
      },
      toolSnapshotDebug: {
        captureResult: {
          status: "complete",
          serverCount: 1,
          toolCount: 1,
          failedServerCount: 0,
          failedServerIds: [],
        },
        promptSection: "# Available MCP Tools",
        promptSectionTruncated: false,
        promptSectionMaxChars: 30000,
        fallbackReason: null,
        fullSnapshot: null,
      },
    });
    startSuiteRunWithRecorderMock.mockResolvedValue({
      runId: "replay-run",
      recorder: null,
      config: {
        tests: [],
        environment: { servers: ["excalidraw"] },
      },
    });
    runEvalSuiteWithAiSdkMock.mockResolvedValue(undefined);
    storeReplayConfigMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stores replay config on the new run and executes with replay-config server ids", async () => {
    const response = await createApp().request("/api/mcp/evals/replay-run", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        runId: "source-run",
        convexAuthToken: "token-123",
      }),
    });

    expect(response.status).toBe(200);
    expect(startSuiteRunWithRecorderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        serverIds: ["excalidraw"],
        replayedFromRunId: "source-run",
        toolSnapshot: expect.objectContaining({
          servers: [
            expect.objectContaining({
              serverId: "excalidraw",
            }),
          ],
        }),
        toolSnapshotDebug: expect.objectContaining({
          captureResult: expect.objectContaining({
            status: "complete",
          }),
        }),
      }),
    );
    expect(storeReplayConfigMock).toHaveBeenCalledWith(
      "replay-run",
      [
        {
          serverId: "excalidraw",
          url: "https://mcp.excalidraw.com",
        },
      ],
      "token-123",
    );
    expect(runEvalSuiteWithAiSdkMock).toHaveBeenCalledTimes(1);
    expect(disconnectAllServersMock).toHaveBeenCalledTimes(1);
  });
});
