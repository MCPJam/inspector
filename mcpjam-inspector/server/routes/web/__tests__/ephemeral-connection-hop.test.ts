import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * `withEphemeralConnection`'s catch is the highest-traffic error path in the
 * server — `/api/web/tools/list` and `/api/web/servers/validate` alone
 * produced 2,266 of 2,851 prod `http.request.failed` rows in 7 days — and it
 * declared nothing about which hop failed.
 *
 * The declaration has to be a SPAN, not a whole-route flag, and that split is
 * what these tests pin. Everything before `fn` is MCPJam's hop:
 * `getConvexBearerForRequest`, `fetchScenarioRuntimeConfig` and
 * `createAuthorizedManager` all reach our own Convex deployment. Marking the
 * whole catch would stop paging us during a Convex outage AND tell the user
 * their MCP server was down — strictly worse than the noise being fixed.
 *
 * `createAuthorizedManager` returns without awaiting its connects (the
 * constructor queues them as microtasks), so the first thing that actually
 * touches the user's server is the manager op inside `fn`. That makes `fn`
 * the narrowest span that still catches connect failures.
 */
vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock("../../../utils/logger.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/logger.js")
  >("../../../utils/logger.js");
  return { ...actual, logger: { ...actual.logger, event: vi.fn() } };
});

/** The user's server refuses the connection on the first manager op. */
const TARGET_FAILURE = Object.assign(new TypeError("fetch failed"), {
  code: "ECONNREFUSED",
});

vi.mock("@mcpjam/sdk", async () => {
  const actual = await vi.importActual<typeof import("@mcpjam/sdk")>(
    "@mcpjam/sdk"
  );
  class MockMCPClientManager {
    async listTools() {
      // The real failure shape: `createAuthorizedManager` has already
      // returned, and the queued connect fails when the first op awaits it.
      throw TARGET_FAILURE;
    }
    getAllToolsMetadata() {
      return undefined;
    }
    setPerRequestLogLevel() {}
    async disconnectAllServers() {
      return undefined;
    }
  }
  return {
    ...actual,
    MCPClientManager: MockMCPClientManager,
    isMCPAuthError: vi.fn().mockReturnValue(false),
  };
});

import { logger } from "../../../utils/logger.js";
import { requestLogContextMiddleware } from "../../../middleware/request-log-context.js";
import toolsRoutes from "../tools.js";

function createTestApp(): Hono {
  const app = new Hono();
  app.use("/api/*", requestLogContextMiddleware);
  app.use("*", async (c, next) => {
    c.set("guestId", "guest-1");
    await next();
  });
  app.route("/api/web/tools", toolsRoutes);
  return app;
}

function postList(app: Hono) {
  return app.request("/api/web/tools/list", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-token",
    },
    body: JSON.stringify({
      projectId: "project-1",
      serverId: "srv-1",
      serverName: "Notion",
    }),
  });
}

function failedEvent() {
  const calls = vi
    .mocked(logger.event)
    .mock.calls.filter(([name]) => name === "http.request.failed");
  expect(calls).toHaveLength(1);
  return calls[0][2] as Record<string, unknown>;
}

describe("withEphemeralConnection hop declaration", () => {
  const originalFetch = global.fetch;
  const originalConvexHttpUrl = process.env.CONVEX_HTTP_URL;

  /** Convex authorizes successfully — MCPJam's hop succeeds. */
  function authorizeSucceeds() {
    global.fetch = vi.fn(async (input) => {
      if (String(input).endsWith("/web/authorize-batch")) {
        return new Response(
          JSON.stringify({
            results: {
              "srv-1": {
                ok: true,
                role: "member",
                accessLevel: "project_member",
                permissions: { chatOnly: false },
                serverConfig: {
                  transportType: "http",
                  url: "https://server.example.com/mcp",
                  headers: {},
                  useOAuth: false,
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    }) as typeof fetch;
  }

  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "https://convex.example.com";
    vi.mocked(logger.event).mockClear();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalConvexHttpUrl) {
      process.env.CONVEX_HTTP_URL = originalConvexHttpUrl;
    } else {
      delete process.env.CONVEX_HTTP_URL;
    }
  });

  it("declares user_server_hop when the manager op fails", async () => {
    authorizeSucceeds();

    const res = await postList(createTestApp());
    const payload = failedEvent();

    expect(payload.hop).toBe("user_server_hop");
    // Attribution only. The 424 downgrade `chat-v2` already applies to an
    // unreachable target is a separate, user-visible change; this one must
    // not move the status, so the assertion pins that too.
    expect(res.status).toBe(502);
    expect(payload.statusCode).toBe(502);
  });

  it("leaves a failure in MCPJam's own hop unattributed", async () => {
    // Convex — our deployment — is what breaks here. This is the converse
    // that keeps the span honest: if this row ever carries
    // `user_server_hop`, the new monitor goes blind during our own outage.
    global.fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;

    await postList(createTestApp());
    const payload = failedEvent();

    expect(payload.hop).toBeUndefined();
    expect("hop" in payload).toBe(false);
  });
});
