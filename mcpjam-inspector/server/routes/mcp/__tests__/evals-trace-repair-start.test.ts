import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  app.route("/api/mcp/evals", evalsRoutes);
  return app;
}

describe("mcp trace-repair/start", () => {
  const originalConvexUrl = process.env.CONVEX_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_URL = "https://example.convex.cloud";
  });

  afterEach(() => {
    if (originalConvexUrl === undefined) {
      delete process.env.CONVEX_URL;
    } else {
      process.env.CONVEX_URL = originalConvexUrl;
    }
  });

  it("passes targetSourceIterationId for case scope", async () => {
    mutationMock.mockResolvedValueOnce({ jobId: "job-new", existing: false });
    const app = createApp();
    const res = await app.request("/api/mcp/evals/trace-repair/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "case",
        suiteId: "suite-1",
        sourceRunId: "run-1",
        testCaseId: "tc-1",
        sourceIterationId: "iter-2",
        convexAuthToken: "tok",
      }),
    });
    expect(res.status).toBe(200);

    expect(mutationMock).toHaveBeenCalledWith(
      "traceRepair:startTraceRepairJob",
      expect.objectContaining({
        targetSourceIterationId: "iter-2",
      }),
    );
    expect(runTraceRepairJobMock).toHaveBeenCalledTimes(1);
  });

  it("does not spawn worker when Convex returns existing job", async () => {
    mutationMock.mockResolvedValueOnce({ jobId: "job-old", existing: true });
    const app = createApp();
    const res = await app.request("/api/mcp/evals/trace-repair/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "case",
        suiteId: "suite-1",
        sourceRunId: "run-1",
        testCaseId: "tc-1",
        sourceIterationId: "iter-9",
        convexAuthToken: "tok",
      }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { existing: boolean };
    expect(data.existing).toBe(true);
    expect(runTraceRepairJobMock).not.toHaveBeenCalled();
  });
});
