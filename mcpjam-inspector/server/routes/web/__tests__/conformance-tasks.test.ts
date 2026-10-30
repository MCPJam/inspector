import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

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
  const { default: conformanceWeb } = await import("../conformance.js");
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

  it("answers 504 when the whole run outlives the request budget", async () => {
    vi.useFakeTimers();
    // A run that never settles: only the route-level deadline can end it.
    runTasksConformanceMock.mockReturnValue(new Promise(() => {}));

    const pending = post({ projectId: "p1", serverId: "s1" });
    await vi.advanceTimersByTimeAsync(30_000);
    const res = await pending;

    expect(res.status).toBe(504);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("TIMEOUT");
    expect(body.message).toMatch(/hosted request budget/);
  });
});
