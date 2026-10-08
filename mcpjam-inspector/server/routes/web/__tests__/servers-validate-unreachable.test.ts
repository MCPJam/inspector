import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * BB-48. A hosted connect to a well-formed but unreachable URL must come back
 * as a 4xx carrying the reason, not as a `502 SERVER_UNREACHABLE`: the hosted
 * edge replaces an origin 5xx with its own error page, which discards the JSON
 * envelope, and the browser is then left with a bare "Request failed (502)"
 * and nothing to show the user once the toast clears.
 */

const { mcpClientManagerMock, getToolsForAiSdkMock, disconnectAllServersMock } =
  vi.hoisted(() => ({
    mcpClientManagerMock: vi.fn(),
    getToolsForAiSdkMock: vi.fn(),
    disconnectAllServersMock: vi.fn(),
  }));

// The inspection snapshot and its fire-and-forget Convex write are not what
// this file is about: stubbed so the success case exercises the route's own
// envelope rather than the exporter's manager calls or a live Convex mutation.
vi.mock("../../../utils/export-helpers.js", () => ({
  exportSingleServerForInspection: vi.fn(async () => ({ tools: [] })),
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth() {}
    async mutation() {
      return null;
    }
  },
}));

vi.mock("@mcpjam/sdk", async () => {
  const actual = await vi.importActual<typeof import("@mcpjam/sdk")>(
    "@mcpjam/sdk",
  );
  return {
    ...actual,
    MCPClientManager: mcpClientManagerMock.mockImplementation(function () {
      return {
        getToolsForAiSdk: getToolsForAiSdkMock,
        disconnectAllServers: disconnectAllServersMock,
        setPerRequestLogLevel: vi.fn(),
        getInitializationInfo: vi.fn(() => ({
          serverInfo: { name: "test-server", version: "1.0.0" },
        })),
      };
    }),
  };
});

const { default: serversRoute, remainingServerCheckBudget } = await import(
  "../servers.js"
);

// The failure the SDK raises for a hostname that does not resolve. The wording
// matters: `mapTargetServerError` only downgrades a connection-class failure
// whose message positively names an MCP server, so MCPJam's own hops keep
// their 5xx.
const UNREACHABLE_ERROR = new Error(
  'Failed to connect to MCP server "srv_1" using HTTP transports. ' +
    "Streamable HTTP error: fetch failed. SSE error: getaddrinfo ENOTFOUND " +
    "no-such-mcp-server.example.",
);

function authorizeBatchResponse() {
  return new Response(
    JSON.stringify({
      results: {
        srv_1: {
          ok: true,
          role: "member",
          accessLevel: "project_member",
          permissions: { chatOnly: false },
          serverConfig: {
            transportType: "http",
            url: "https://no-such-mcp-server.example/mcp",
          },
        },
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function postValidate(body: unknown = { projectId: "prj_1", serverId: "srv_1" }) {
  return serversRoute.request("/validate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-token",
    },
    body: JSON.stringify(body),
  });
}

describe("hosted /api/web/servers/validate — unreachable target", () => {
  const originalFetch = global.fetch;
  const originalConvexHttpUrl = process.env.CONVEX_HTTP_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
    global.fetch = vi.fn(async () => authorizeBatchResponse()) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalConvexHttpUrl === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = originalConvexHttpUrl;
    }
  });

  it("answers 424 with the failure reason instead of a body-less 502", async () => {
    getToolsForAiSdkMock.mockRejectedValue(UNREACHABLE_ERROR);

    const res = await postValidate();

    expect(res.status).toBe(424);
    const body = (await res.json()) as {
      error?: string;
      message?: string;
      code?: string;
    };
    const reason = body.message ?? body.error ?? "";
    expect(reason).toContain("Couldn't reach the MCP server");
    expect(reason).toContain("ENOTFOUND");
    expect(body.code).toBe("SERVER_UNREACHABLE");
  });

  it("leaves an MCPJam-side failure on its 5xx so it still pages us", async () => {
    // No MCP server named in the message — the shape of our own outbound hops
    // (a bare `fetch failed` from the Convex deployment). It must NOT be
    // relabelled as the user's dependency.
    getToolsForAiSdkMock.mockRejectedValue(new Error("fetch failed"));

    const res = await postValidate();

    expect(res.status).toBe(502);
  });

  it("still answers 200 with the connect envelope when the target is reachable", async () => {
    getToolsForAiSdkMock.mockResolvedValue({});

    const res = await postValidate();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true,
      status: "connected",
    });
  });

  it.each([
    ["an empty body", {}],
    ["a null body", null],
    ["a body missing serverId", { projectId: "prj_1" }],
  ])("rejects %s as a client error, not a dependency failure", async (
    _label,
    body
  ) => {
    getToolsForAiSdkMock.mockResolvedValue({});

    const res = await postValidate(body);

    // A malformed request is the caller's to fix. `mapTargetServerError` only
    // moves connection-class failures that name an MCP server, so a schema
    // rejection must keep landing in the 4xx band it always did — and never
    // reach the target at all.
    expect(res.status).toBe(400);
    expect(getToolsForAiSdkMock).not.toHaveBeenCalled();
  });
});

/**
 * The hosted Connect deadline. The button gives up 50 s after it sends the
 * request, so the server must answer with its own reason inside that: 45 s
 * from the request's arrival, which the server-check middleware records.
 */
describe("hosted /api/web/servers/validate — connect deadline", () => {
  const originalFetch = global.fetch;
  const originalConvexHttpUrl = process.env.CONVEX_HTTP_URL;

  /** The route behind a stand-in for the middleware's arrival stamp. */
  function postWithArrival(startedAt: number | undefined) {
    const app = new Hono();
    app.use("*", async (c, next) => {
      if (startedAt !== undefined) c.set("serverCheckStartedAt", startedAt);
      await next();
    });
    app.route("/", serversRoute);
    return app.request("/validate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({ projectId: "prj_1", serverId: "srv_1" }),
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
    global.fetch = vi.fn(async () => authorizeBatchResponse()) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalConvexHttpUrl === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = originalConvexHttpUrl;
    }
  });

  it("counts the budget from the request's arrival", () => {
    expect(remainingServerCheckBudget(undefined)).toBeUndefined();
    expect(remainingServerCheckBudget(1_000, 1_000)).toBe(45_000);
    expect(remainingServerCheckBudget(1_000, 31_000)).toBe(15_000);
    expect(remainingServerCheckBudget(1_000, 99_000)).toBe(0);
  });

  it("answers a hung connect with a 424 TIMEOUT and tears the connect down", async () => {
    getToolsForAiSdkMock.mockReturnValue(new Promise(() => {}));

    // Arrived 44.95 s ago (as after a long queue wait): 50 ms are left.
    const res = await postWithArrival(Date.now() - 44_950);

    expect(res.status).toBe(424);
    const body = (await res.json()) as { message?: string; code?: string };
    expect(body.code).toBe("TIMEOUT");
    expect(body.message).toMatch(/MCP server "srv_1" timed out/);
    expect(disconnectAllServersMock).toHaveBeenCalled();
  });

  it("still returns a connect that finishes inside the budget", async () => {
    getToolsForAiSdkMock.mockResolvedValue({});

    const res = await postWithArrival(Date.now());

    expect(res.status).toBe(200);
  });

  it("sets no deadline when no server-check middleware ran (outside hosted)", async () => {
    getToolsForAiSdkMock.mockReturnValue(new Promise(() => {}));

    const settled = await Promise.race([
      Promise.resolve(postWithArrival(undefined)).then(() => "answered"),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 200)),
    ]);

    expect(settled).toBe("pending");
  });
});
