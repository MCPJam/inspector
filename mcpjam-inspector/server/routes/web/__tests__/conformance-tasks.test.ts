import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import conformanceWeb from "../conformance.js";

/**
 * The hosted tasks route has to answer inside the hosted call budget. Capping
 * only the poll window is not enough — connect, `tools/list` and the provoking
 * `tools/call` each carry their own timeout — so the route also pins a
 * per-call ceiling and races the whole run against a wall-clock deadline.
 */

const runTasksConformanceMock = vi.hoisted(() => vi.fn());
const authorizeServerMock = vi.hoisted(() => vi.fn());

vi.mock("../auth.js", async () => {
  const { z } = await import("zod");
  return {
    handleRoute: async (c: any, handler: () => Promise<any>) => {
      try {
        return c.json(await handler(), 200);
      } catch (error: any) {
        return c.json(
          { code: error?.code ?? "INTERNAL_ERROR", message: error?.message },
          error?.status ?? 500,
        );
      }
    },
    projectServerSchema: z.object({}).passthrough(),
    authorizeServer: authorizeServerMock,
    toHttpConfig: (_auth: unknown, timeoutMs: number) => ({
      url: "https://example.test/mcp",
      requestInit: { headers: {} },
      timeout: timeoutMs,
    }),
  };
});

// Path is relative to this test file: the route imports `../shared/conformance`
// from routes/web, which is routes/shared/conformance from routes/web/__tests__.
vi.mock("../../shared/conformance", () => ({
  runTasksConformance: runTasksConformanceMock,
  runAppsConformance: vi.fn(),
  runProtocolConformance: vi.fn(),
  startOAuthConformance: vi.fn(),
  completeOAuthConformance: vi.fn(),
  submitOAuthConformanceCode: vi.fn(),
  UnsupportedTransportError: class extends Error {},
  OAuthConformanceSessionNotFoundError: class extends Error {},
  OAuthConformanceSessionFailedError: class extends Error {},
}));

const post = async (body: Record<string, unknown>) => {
  return conformanceWeb.request("/tasks", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-token",
    },
    body: JSON.stringify(body),
  });
};

describe("POST /api/web/conformance/tasks — hosted budget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authorizeServerMock.mockResolvedValue({
      serverConfig: { url: "https://example.test/mcp" },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("forwards per-check overrides on the hosted path", async () => {
    runTasksConformanceMock.mockResolvedValue({ result: { checks: [] } });
    const checkOverrides = {
      "tasks-inline-result": {
        toolName: "finish",
        toolArguments: { fast: true },
      },
    };
    expect(
      (await post({ projectId: "p1", serverId: "s1", checkOverrides })).status,
    ).toBe(200);
    expect(runTasksConformanceMock).toHaveBeenCalledWith(
      expect.objectContaining({ checkOverrides }),
    );
  });
  it.each([
    { unknown: { toolName: "job" } },
    { "tasks-inline-result": { toolName: "" } },
  ])("rejects malformed overrides before executing", async (checkOverrides) => {
    const response = await post({
      projectId: "p1",
      serverId: "s1",
      checkOverrides,
    });
    expect(response.status).toBe(400);
    expect(runTasksConformanceMock).not.toHaveBeenCalled();
  });

  it("clamps the poll window and pins a per-call timeout under the budget", async () => {
    runTasksConformanceMock.mockResolvedValue({
      result: { outcome: "passed", checks: [] },
    });

    const res = await post({
      projectId: "p1",
      serverId: "s1",
      pollTimeoutMs: 120_000,
    });

    expect(res.status).toBe(200);
    const config = runTasksConformanceMock.mock.calls[0][0];
    // Caller asked for two minutes; the hosted cap wins.
    expect(config.pollTimeoutMs).toBe(20_000);
    // And each MCP leg is bounded well below WEB_CALL_TIMEOUT_MS (30s), so
    // three slow legs cannot compose past the request budget.
    expect(config.timeout).toBe(10_000);
  });

  it("forwards the tool, its arguments and the input answers", async () => {
    runTasksConformanceMock.mockResolvedValue({
      result: { outcome: "passed", checks: [] },
    });
    const inputResponses = { confirm: { action: "accept" } };

    const res = await post({
      projectId: "p1",
      serverId: "s1",
      toolName: "long-job",
      toolArguments: { seconds: 2 },
      inputResponses,
    });

    expect(res.status).toBe(200);
    const config = runTasksConformanceMock.mock.calls[0][0];
    expect(config.toolName).toBe("long-job");
    expect(config.toolArguments).toEqual({ seconds: 2 });
    expect(config.inputResponses).toEqual(inputResponses);
  });

  it("answers 504 when the whole run outlives the request budget", async () => {
    vi.useFakeTimers();
    let cleanedUp = false;
    runTasksConformanceMock.mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              setTimeout(() => {
                cleanedUp = true;
                reject(signal.reason);
              }, 100);
            },
            { once: true },
          );
        }),
    );

    const pending = post({ projectId: "p1", serverId: "s1" });
    let answered = false;
    void pending.then(() => {
      answered = true;
    });
    await vi.advanceTimersByTimeAsync(28_000);
    expect(runTasksConformanceMock.mock.calls[0][0].signal.aborted).toBe(true);
    expect(answered).toBe(false);
    expect(cleanedUp).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    const res = await pending;
    expect(cleanedUp).toBe(true);

    expect(res.status).toBe(504);
    expect(runTasksConformanceMock.mock.calls[0][0].signal.aborted).toBe(true);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("TIMEOUT");
    expect(body.message).toMatch(/hosted request budget/);
  });
});
