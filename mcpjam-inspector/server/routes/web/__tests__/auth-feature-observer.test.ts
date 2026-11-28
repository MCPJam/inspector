/**
 * Observed server features are opt-in per authorized manager: a user's own
 * interactive session asks for them, and every other caller (evals, checks,
 * bench, simulations, the Connect button) builds a manager that observes
 * nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const constructions = vi.hoisted(
  () => [] as Array<Record<string, unknown> | undefined>,
);

vi.mock("@mcpjam/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mcpjam/sdk")>();
  class RecordingManager {
    constructor(_configs: unknown, options?: Record<string, unknown>) {
      constructions.push(options);
    }
    setElicitationCallback() {}
    async disconnectAllServers() {}
  }
  return { ...actual, MCPClientManager: RecordingManager };
});

const { createAuthorizedManager, projectServerSchema, runEphemeralConnection } =
  await import("../auth.js");

const originalFetch = global.fetch;
const originalConvexHttpUrl = process.env.CONVEX_HTTP_URL;

beforeEach(() => {
  constructions.length = 0;
  process.env.CONVEX_HTTP_URL = "https://convex.example.com";
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    if (!String(input).endsWith("/web/authorize-batch")) {
      throw new Error(`Unexpected fetch: ${String(input)}`);
    }
    return new Response(
      JSON.stringify({
        results: {
          s1: {
            ok: true,
            role: "member",
            accessLevel: "project_member",
            permissions: { chatOnly: false },
            serverConfig: { transportType: "http", url: "https://mcp.example.test/mcp" },
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  if (originalConvexHttpUrl === undefined) delete process.env.CONVEX_HTTP_URL;
  else process.env.CONVEX_HTTP_URL = originalConvexHttpUrl;
});

/** Connects through `runEphemeralConnection`, as the hosted routes do. */
async function connectThroughRoute(options?: { observeFeatures?: boolean }) {
  const app = new Hono();
  app.post("/", async (c) => {
    await runEphemeralConnection(
      c,
      { projectId: "p1", serverId: "s1" },
      projectServerSchema,
      async () => null,
      options,
    );
    return c.body(null, 204);
  });
  const response = await app.request("/", {
    method: "POST",
    headers: { Authorization: "Bearer bearer-token" },
  });
  expect(response.status).toBe(204);
}

describe("hosted feature observation", () => {
  it("gives a manager built without the option no observer", async () => {
    await createAuthorizedManager({}, "bearer-token", "p1", ["s1"], 5_000);
    expect(constructions).toHaveLength(1);
    expect(constructions[0]?.featureObserver).toBeUndefined();
  });

  it("gives an interactive session's manager its observer", async () => {
    await createAuthorizedManager(
      {},
      "bearer-token",
      "p1",
      ["s1"],
      5_000,
      undefined,
      undefined,
      { observeFeatures: true },
    );
    expect(typeof constructions[0]?.featureObserver).toBe("function");
  });

  it("passes the choice through the ephemeral connection helpers", async () => {
    await connectThroughRoute();
    await connectThroughRoute({ observeFeatures: true });
    expect(constructions.map((options) => typeof options?.featureObserver)).toEqual([
      "undefined",
      "function",
    ]);
  });
});
