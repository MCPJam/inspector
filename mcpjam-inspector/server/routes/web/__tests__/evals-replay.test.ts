import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bearerAuthMiddleware } from "../../../middleware/bearer-auth.js";
import { guestRateLimitMiddleware } from "../../../middleware/guest-rate-limit.js";
import { mapRuntimeError, webError } from "../errors.js";

const {
  convexQueryMock,
  fetchReplayConfigMock,
  storeReplayConfigMock,
  startSuiteRunWithRecorderMock,
  runEvalSuiteWithAiSdkMock,
  disconnectAllServersMock,
} = vi.hoisted(() => ({
  convexQueryMock: vi.fn(),
  fetchReplayConfigMock: vi.fn(),
  storeReplayConfigMock: vi.fn(),
  startSuiteRunWithRecorderMock: vi.fn(),
  runEvalSuiteWithAiSdkMock: vi.fn(),
  disconnectAllServersMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../services/evals/route-helpers.js", () => ({
  buildReplayManager: vi.fn(() => ({
    disconnectAllServers: disconnectAllServersMock,
  })),
  createConvexClient: vi.fn(() => ({
    query: convexQueryMock,
  })),
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
    return webError(c, routeError.status, routeError.code, routeError.message);
  });
  return app;
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

    expect(response.status).toBe(200);
    expect(startSuiteRunWithRecorderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        serverIds: ["excalidraw"],
        replayedFromRunId: "source-run",
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
