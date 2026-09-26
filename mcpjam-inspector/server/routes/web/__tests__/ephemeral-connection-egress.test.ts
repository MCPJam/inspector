/**
 * MJ-020, MJ-021: a target the egress guard refuses answers 400 from
 * `withEphemeralConnection`, with the guard's own message — however the MCP
 * client wrapped the refusal on its way out of the connect.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const failure = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock("@mcpjam/sdk", async () => {
  const actual =
    await vi.importActual<typeof import("@mcpjam/sdk")>("@mcpjam/sdk");

  class FailingMCPClientManager {
    async listTools() {
      throw failure.current;
    }

    getAllToolsMetadata() {
      return {};
    }

    async disconnectAllServers() {
      return undefined;
    }
  }

  return {
    ...actual,
    MCPClientManager: FailingMCPClientManager,
    isMCPAuthError: vi.fn().mockReturnValue(false),
  };
});

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

const { toolsListSchema, withEphemeralConnection } = await import("../auth.js");
const { BlockedEgressTargetError } =
  await import("../../../utils/hosted-egress-guard.js");

const REFUSAL_MESSAGE =
  'MCP server points at a private or internal address ("127.0.0.1") that the hosted inspector will not dial. Run this server locally in the inspector instead.';

/** The guard's verdict, with the diagnostic it keeps for the log. */
function refusal() {
  return new BlockedEgressTargetError(REFUSAL_MESSAGE, {
    cause: new Error("UNEXPECTED_MARKER resolved address: 10.1.2.3"),
  });
}

/** The shape the MCP client produces when Streamable HTTP and SSE both fail. */
function wrappedAfterSseFallback() {
  const blocked = refusal();
  const error = new Error(
    `Failed to connect to MCP server "srv-1" using HTTP transports. Streamable HTTP error: ${blocked.message}. SSE error: SSE error: ${blocked.message}.`,
    { cause: new Error(`SSE error: ${blocked.message}`) },
  );
  Object.defineProperty(error, "streamableCause", {
    value: blocked,
    enumerable: false,
  });
  return error;
}

/** The shape for a server whose declared transport rules out SSE. */
function wrappedWithoutFallback() {
  const blocked = refusal();
  return new Error(
    `Failed to connect to MCP server "srv-1" using Streamable HTTP. Streamable HTTP error: ${blocked.message}`,
    { cause: blocked },
  );
}

function createApp() {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("guestId", "guest-1");
    await next();
  });
  app.post("/api/web/tools/list", (c) =>
    withEphemeralConnection(
      c,
      toolsListSchema,
      (manager, body) => manager.listTools(body.serverId),
      { rpcLogs: false },
    ),
  );
  return app;
}

function listTools() {
  return createApp().request("/api/web/tools/list", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-token",
    },
    body: JSON.stringify({ projectId: "project-1", serverId: "srv-1" }),
  });
}

describe("withEphemeralConnection egress refusals", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.example.com");
    global.fetch = vi.fn(async (input, init) => {
      if (String(input).endsWith("/web/authorize-batch")) {
        const payload = JSON.parse(String(init?.body ?? "{}"));
        const serverIds: string[] = payload?.serverIds ?? [];
        return Response.json({
          results: Object.fromEntries(
            serverIds.map((serverId) => [
              serverId,
              {
                ok: true,
                role: "member",
                accessLevel: "project_member",
                permissions: { chatOnly: false },
                serverConfig: {
                  transportType: "http",
                  url: "http://127.0.0.1:9000/mcp",
                  headers: {},
                  useOAuth: false,
                },
              },
            ]),
          ),
        });
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it.each([
    ["wrapped after the SSE fallback", wrappedAfterSseFallback],
    ["wrapped by a declared transport", wrappedWithoutFallback],
    ["thrown directly", refusal],
  ])("answers a refused target %s with 400", async (_label, build) => {
    failure.current = build();

    const response = await listTools();

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toMatchObject({
      code: "VALIDATION_ERROR",
      message: REFUSAL_MESSAGE,
    });
    expect(JSON.stringify(body)).not.toContain("UNEXPECTED_MARKER");
  });

  it("keeps the connection-failure answer for a target that was dialed", async () => {
    failure.current = new Error(
      'Failed to connect to MCP server "srv-1" using HTTP transports. SSE error: fetch failed.',
      {
        cause: Object.assign(new Error("connect ECONNREFUSED"), {
          code: "ECONNREFUSED",
        }),
      },
    );

    const response = await listTools();

    expect(response.status).toBe(424);
    expect((await response.json()).code).toBe("SERVER_UNREACHABLE");
  });
});
