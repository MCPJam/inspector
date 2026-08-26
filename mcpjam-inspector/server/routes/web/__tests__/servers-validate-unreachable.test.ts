import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("@mcpjam/sdk", async () => {
  const actual = await vi.importActual<typeof import("@mcpjam/sdk")>(
    "@mcpjam/sdk",
  );
  return {
    ...actual,
    MCPClientManager: mcpClientManagerMock.mockImplementation(() => ({
      getToolsForAiSdk: getToolsForAiSdkMock,
      disconnectAllServers: disconnectAllServersMock,
      setPerRequestLogLevel: vi.fn(),
    })),
  };
});

const serversRoute = (await import("../servers.js")).default;

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

function postValidate() {
  return serversRoute.request("/validate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-token",
    },
    body: JSON.stringify({ projectId: "prj_1", serverId: "srv_1" }),
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
});
