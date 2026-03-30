import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bearerAuthMiddleware } from "../../../middleware/bearer-auth.js";
import { guestRateLimitMiddleware } from "../../../middleware/guest-rate-limit.js";
import { mapRuntimeError, webError } from "../errors.js";

const { mutationMock, createConvexClientMock, runTraceRepairJobMock } =
  vi.hoisted(() => ({
    mutationMock: vi.fn(),
    createConvexClientMock: vi.fn(() => ({
      mutation: mutationMock,
      query: vi.fn(),
    })),
    runTraceRepairJobMock: vi.fn().mockResolvedValue(undefined),
  }));

vi.mock("../../../services/evals/route-helpers.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../services/evals/route-helpers.js")
  >("../../../services/evals/route-helpers.js");
  return {
    ...actual,
    createConvexClient: createConvexClientMock,
  };
});

vi.mock("../../../services/evals/trace-repair-runner.js", () => ({
  runTraceRepairJob: (...args: unknown[]) => runTraceRepairJobMock(...args),
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

function stubAuthorizeOk() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          authorized: true,
          role: "member",
          accessLevel: "workspace_member",
          permissions: { chatOnly: false },
          serverConfig: {
            transportType: "http",
            url: "https://server.example.com/mcp",
            headers: {},
            useOAuth: false,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ),
  );
}

describe("web trace-repair/start", () => {
  const originalConvexHttpUrl = process.env.CONVEX_HTTP_URL;
  const originalConvexUrl = process.env.CONVEX_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
    process.env.CONVEX_URL = "https://example.convex.cloud";
    stubAuthorizeOk();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalConvexHttpUrl === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = originalConvexHttpUrl;
    }
    if (originalConvexUrl === undefined) {
      delete process.env.CONVEX_URL;
    } else {
      process.env.CONVEX_URL = originalConvexUrl;
    }
  });

  it("passes targetSourceIterationId for case scope", async () => {
    mutationMock.mockResolvedValueOnce({ jobId: "job-new", existing: false });
    const app = createApp();
    const res = await app.request("/api/web/evals/trace-repair/start", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer t",
      },
      body: JSON.stringify({
        scope: "case",
        suiteId: "suite-1",
        sourceRunId: "run-1",
        testCaseId: "tc-1",
        sourceIterationId: "iter-2",
      }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { jobId: string; existing: boolean };
    expect(data.jobId).toBe("job-new");
    expect(data.existing).toBe(false);

    expect(mutationMock).toHaveBeenCalledWith(
      "traceRepair:startTraceRepairJob",
      expect.objectContaining({
        testSuiteId: "suite-1",
        sourceRunId: "run-1",
        scope: "case",
        targetTestCaseId: "tc-1",
        targetSourceIterationId: "iter-2",
      }),
    );
    expect(runTraceRepairJobMock).toHaveBeenCalledTimes(1);
  });

  it("mixed-version fallback: does not spawn when existing true and shouldSpawnWorker omitted", async () => {
    mutationMock.mockResolvedValueOnce({ jobId: "job-old", existing: true });
    const app = createApp();
    const res = await app.request("/api/web/evals/trace-repair/start", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer t",
      },
      body: JSON.stringify({
        scope: "case",
        suiteId: "suite-1",
        sourceRunId: "run-1",
        testCaseId: "tc-1",
        sourceIterationId: "iter-9",
      }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { existing: boolean };
    expect(data.existing).toBe(true);
    expect(runTraceRepairJobMock).not.toHaveBeenCalled();
  });

  it("does not spawn worker when shouldSpawnWorker is false", async () => {
    mutationMock.mockResolvedValueOnce({
      jobId: "job-old",
      existing: true,
      shouldSpawnWorker: false,
    });
    const app = createApp();
    const res = await app.request("/api/web/evals/trace-repair/start", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer t",
      },
      body: JSON.stringify({
        scope: "case",
        suiteId: "suite-1",
        sourceRunId: "run-1",
        testCaseId: "tc-1",
        sourceIterationId: "iter-9",
      }),
    });
    expect(res.status).toBe(200);
    expect(runTraceRepairJobMock).not.toHaveBeenCalled();
  });

  it("spawns worker when existing true and shouldSpawnWorker true (recoverable queued)", async () => {
    mutationMock.mockResolvedValueOnce({
      jobId: "job-queued",
      existing: true,
      shouldSpawnWorker: true,
    });
    const app = createApp();
    const res = await app.request("/api/web/evals/trace-repair/start", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer t",
      },
      body: JSON.stringify({
        scope: "case",
        suiteId: "suite-1",
        sourceRunId: "run-1",
        testCaseId: "tc-1",
        sourceIterationId: "iter-9",
      }),
    });
    expect(res.status).toBe(200);
    expect(runTraceRepairJobMock).toHaveBeenCalledTimes(1);
  });

  it("omits targetSourceIterationId for suite scope and still spawns worker", async () => {
    mutationMock.mockResolvedValueOnce({ jobId: "job-suite", existing: false });
    const app = createApp();
    const res = await app.request("/api/web/evals/trace-repair/start", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer t",
      },
      body: JSON.stringify({
        scope: "suite",
        suiteId: "suite-1",
        sourceRunId: "run-1",
      }),
    });
    expect(res.status).toBe(200);
    expect(mutationMock).toHaveBeenCalledWith(
      "traceRepair:startTraceRepairJob",
      expect.objectContaining({
        scope: "suite",
        targetTestCaseId: undefined,
        targetSourceIterationId: undefined,
      }),
    );
    expect(runTraceRepairJobMock).toHaveBeenCalledTimes(1);
  });
});
