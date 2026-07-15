import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bearerAuthMiddleware } from "../../../middleware/bearer-auth.js";
import { guestRateLimitMiddleware } from "../../../middleware/guest-rate-limit.js";
import { mapRuntimeError, webError } from "../errors.js";

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

import evalsRoutes from "../evals.js";

function createApp() {
  const app = new Hono();
  app.use("/api/web/evals/*", bearerAuthMiddleware, guestRateLimitMiddleware);
  app.route("/api/web/evals", evalsRoutes);
  app.onError((error, c) => {
    const routeError = mapRuntimeError(error);
    return webError(
      c,
      routeError.status,
      routeError.code,
      routeError.message,
      routeError.details,
    );
  });
  return app;
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushPromises() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

describe("web replay route", () => {
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
    const execution = deferred();
    runEvalSuiteWithAiSdkMock.mockReturnValueOnce(execution.promise);

    const response = await createApp().request("/api/web/evals/replay-run", {
      method: "POST",
      headers: {
        Authorization: "Bearer token-123",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        runId: "source-run",
      }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      suiteId: "suite-1",
      runId: "replay-run",
      sourceRunId: "source-run",
      status: "running",
      message: "Replay started. Results will appear shortly.",
    });
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
    expect(disconnectAllServersMock).not.toHaveBeenCalled();

    await flushPromises();
    expect(runEvalSuiteWithAiSdkMock).toHaveBeenCalledTimes(1);
    expect(disconnectAllServersMock).not.toHaveBeenCalled();

    execution.resolve(undefined);
    await flushPromises();

    expect(disconnectAllServersMock).toHaveBeenCalledTimes(1);
  });

  it("marks replay runs failed when detached execution rejects", async () => {
    const execution = deferred();
    const finalize = vi.fn().mockResolvedValue(undefined);
    startSuiteRunWithRecorderMock.mockResolvedValueOnce({
      runId: "replay-run",
      recorder: { finalize },
      config: {
        tests: [],
        environment: { servers: ["excalidraw"] },
      },
      hostConfig: {},
    });
    runEvalSuiteWithAiSdkMock.mockReturnValueOnce(execution.promise);

    const response = await createApp().request("/api/web/evals/replay-run", {
      method: "POST",
      headers: {
        Authorization: "Bearer token-123",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        runId: "source-run",
      }),
    });

    expect(response.status).toBe(202);
    await flushPromises();

    execution.reject(new Error("replay provider failed"));
    await flushPromises();

    expect(finalize).toHaveBeenCalledWith({
      status: "failed",
      notes: "replay provider failed",
    });
    expect(disconnectAllServersMock).toHaveBeenCalledTimes(1);
  });

  it("does not re-finalize replay runs that are already terminal", async () => {
    const execution = deferred();
    const finalize = vi.fn().mockResolvedValue(undefined);
    convexQueryMock
      .mockResolvedValueOnce({
        suiteId: "suite-1",
        hasServerReplayConfig: true,
        environment: { servers: ["srv_asana"] },
      })
      .mockResolvedValue({ status: "completed" });
    startSuiteRunWithRecorderMock.mockResolvedValueOnce({
      runId: "replay-run",
      recorder: { finalize },
      config: {
        tests: [],
        environment: { servers: ["excalidraw"] },
      },
      hostConfig: {},
    });
    runEvalSuiteWithAiSdkMock.mockReturnValueOnce(execution.promise);

    const response = await createApp().request("/api/web/evals/replay-run", {
      method: "POST",
      headers: {
        Authorization: "Bearer token-123",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        runId: "source-run",
      }),
    });

    expect(response.status).toBe(202);
    await flushPromises();

    execution.reject(new Error("cancelled elsewhere"));
    await flushPromises();

    expect(finalize).not.toHaveBeenCalled();
    expect(disconnectAllServersMock).toHaveBeenCalledTimes(1);
  });
});
