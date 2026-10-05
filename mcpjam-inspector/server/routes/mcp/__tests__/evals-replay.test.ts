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
      hostConfig: {},
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

  // `passCriteria` here was a bare, unbounded `z.object({ minimumPassRate:
  // z.number() })`: it STRIPPED the canonical `minimumPassRatePercent` — a
  // replay silently losing the one override it was sent to apply — and
  // accepted any number, so `0.8` meant 0.8% and produced a gate that could
  // not fail. Both are the defects this PR fixes on the other write surfaces.
  describe("the pass-criteria override", () => {
    async function replay(passCriteria: unknown): Promise<Response> {
      return createApp().request("/api/mcp/evals/replay-run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId: "source-run",
          convexAuthToken: "token-123",
          passCriteria,
        }),
      });
    }

    it("carries the canonical spelling through instead of dropping it", async () => {
      const response = await replay({ minimumPassRatePercent: 80 });

      expect(response.status).toBe(200);
      expect(startSuiteRunWithRecorderMock).toHaveBeenCalledWith(
        expect.objectContaining({
          // Normalized to the stored name, and PRESENT — a strip would leave
          // this undefined and the replay would run on the suite default.
          passCriteria: { minimumPassRate: 80 },
        }),
      );
    });

    it("still carries the deprecated spelling", async () => {
      const response = await replay({ minimumPassRate: 80 });

      expect(response.status).toBe(200);
      expect(startSuiteRunWithRecorderMock).toHaveBeenCalledWith(
        expect.objectContaining({ passCriteria: { minimumPassRate: 80 } }),
      );
    });

    it("refuses a fraction, which would make the replay's gate unfailable", async () => {
      const response = await replay({ minimumPassRate: 0.8 });

      expect(response.status).toBe(400);
      expect(startSuiteRunWithRecorderMock).not.toHaveBeenCalled();
    });

    it("refuses a percent above 100", async () => {
      const response = await replay({ minimumPassRate: 8000 });

      expect(response.status).toBe(400);
      expect(startSuiteRunWithRecorderMock).not.toHaveBeenCalled();
    });
  });
});
