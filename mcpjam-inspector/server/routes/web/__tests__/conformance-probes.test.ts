import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The hosted protocol route passes unknown fields through to the project and
 * guest resolvers, so the probe fields need their own guard: a malformed probe
 * must be a 400 here too, before any tool is called.
 */

const runProtocolConformanceMock = vi.hoisted(() => vi.fn());
const authorizeServerMock = vi.hoisted(() => vi.fn());

vi.mock("../auth.js", async () => {
  const { z } = await import("zod");
  return {
    handleRoute: async (
      c: { json: (body: unknown, status: number) => Response },
      handler: () => Promise<unknown>,
    ) => {
      try {
        return c.json(await handler(), 200);
      } catch (error) {
        const { code, message, status } = error as {
          code?: string;
          message?: string;
          status?: number;
        };
        return c.json(
          { code: code ?? "INTERNAL_ERROR", message },
          status ?? 500,
        );
      }
    },
    projectServerSchema: z.object({}).passthrough(),
    authorizeServer: authorizeServerMock,
    toHttpConfig: (_auth: unknown, timeoutMs: number) => ({
      url: "https://mcp.example.test/mcp",
      requestInit: { headers: {} },
      timeout: timeoutMs,
    }),
  };
});

vi.mock("../../shared/conformance", () => ({
  runProtocolConformance: runProtocolConformanceMock,
  runAppsConformance: vi.fn(),
  runTasksConformance: vi.fn(),
  startOAuthConformance: vi.fn(),
  completeOAuthConformance: vi.fn(),
  submitOAuthConformanceCode: vi.fn(),
  UnsupportedTransportError: class extends Error {},
  OAuthConformanceSessionNotFoundError: class extends Error {},
  OAuthConformanceSessionFailedError: class extends Error {},
}));

async function postProtocol(body: Record<string, unknown>) {
  const { default: conformanceWeb } = await import("../conformance.js");
  return conformanceWeb.request("/protocol", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-token",
    },
    body: JSON.stringify({ projectId: "p1", serverId: "s1", ...body }),
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  // `mcp.example.test` never resolves. Pin the egress guard's DNS so these
  // tests reach the mocked runner in hosted mode too.
  const guard = await import("../../../utils/hosted-egress-guard.js");
  guard.setEgressHostResolverForTests(async () => ["93.184.216.34"]);
  authorizeServerMock.mockResolvedValue({
    serverConfig: {
      transportType: "http",
      url: "https://mcp.example.test/mcp",
    },
  });
  runProtocolConformanceMock.mockResolvedValue({
    result: { outcome: "passed", checks: [] },
  });
});

afterEach(async () => {
  vi.useRealTimers();
  const guard = await import("../../../utils/hosted-egress-guard.js");
  guard.setEgressHostResolverForTests(null);
});

describe("POST /api/web/conformance/protocol probe tools", () => {
  it("forwards the named probe tools to the protocol run", async () => {
    const res = await postProtocol({
      logProbe: { toolName: "emit-logs", arguments: { count: 2 } },
      inputRequiredProbe: { toolName: "ask-user" },
      toolCallProbe: { toolName: "weather" },
    });

    expect(res.status).toBe(200);
    expect(runProtocolConformanceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        logProbe: { toolName: "emit-logs", arguments: { count: 2 } },
        inputRequiredProbe: { toolName: "ask-user" },
        toolCallProbe: { toolName: "weather" },
      }),
    );
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
    expect(runProtocolConformanceMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/web/conformance/protocol advice picks", () => {
  it("forwards the picked advice, an empty list included", async () => {
    await postProtocol({ readinessIds: ["readiness-log-level-filtering"] });
    await postProtocol({ readinessIds: [] });

    const inputs = runProtocolConformanceMock.mock.calls.map(
      (call) => call[0].readinessIds,
    );
    expect(inputs).toEqual([["readiness-log-level-filtering"], []]);
  });

  it("rejects an unknown advice id before running anything", async () => {
    const res = await postProtocol({ readinessIds: ["readiness-made-up"] });
    expect(res.status).toBe(400);
    expect(runProtocolConformanceMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/web/conformance/protocol time limits", () => {
  it("gives each check the CLI's 15 second limit", async () => {
    await postProtocol({});
    expect(runProtocolConformanceMock).toHaveBeenCalledWith(
      expect.objectContaining({ checkTimeout: 15_000 }),
    );
  });

  it("answers 504 with its own message when the run outlives the hosted limit", async () => {
    vi.useFakeTimers();
    // A run that never settles: only the route-level deadline can end it.
    runProtocolConformanceMock.mockReturnValue(new Promise(() => {}));

    const pending = postProtocol({});
    await vi.advanceTimersByTimeAsync(85_000);
    const res = await pending;

    expect(res.status).toBe(504);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("TIMEOUT");
    expect(body.message).toMatch(
      /^The Protocol checks took longer than the 85-second limit/,
    );
  });
});
