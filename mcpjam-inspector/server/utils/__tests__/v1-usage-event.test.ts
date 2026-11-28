/**
 * `api_v1_request_completed`: one event per Platform API request, emitted by
 * the request-log middleware. Driven through a real Hono app so the route
 * pattern, the status after `v1OnError`, and a middleware's early refusal are
 * the ones production sees.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono, type Context, type Next } from "hono";

const captureMock = vi.fn();
const posthogOptions: Array<Record<string, unknown>> = [];

vi.mock("posthog-node", () => ({
  PostHog: vi.fn(function (_key: string, options: Record<string, unknown>) {
    posthogOptions.push(options);
    return { capture: captureMock, shutdown: vi.fn() };
  }),
}));

const hosted = vi.hoisted(() => ({ value: true }));
vi.mock("../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config.js")>();
  return {
    ...actual,
    get HOSTED_MODE() {
      return hosted.value;
    },
  };
});

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    flush: vi.fn(),
    event: vi.fn(),
    systemEvent: vi.fn(),
  },
}));

import { requestLogContextMiddleware } from "../../middleware/request-log-context.js";
import { v1Error, v1OnError } from "../../routes/v1/envelope.js";
import { resolveSurface } from "../v1-usage-event.js";
import { expectTelemetryFields } from "../../../shared/__tests__/explain-telemetry.js";

/** A WorkOS user id in the shape the transport accepts as an actor. */
const WORKER_USER = "user_01J9ZXQ4M8V2N6P3R5T7W9Y1A3";

type Auth = Partial<{
  authMethod: string;
  workosUserId: string;
  analyticsUserId: string;
  guestId: string;
  mcpjamOrganizationId: string;
}>;

function createApp(auth: Auth) {
  const app = new Hono();
  app.use("/api/*", requestLogContextMiddleware);
  const v1 = new Hono();
  v1.use("*", async (c: Context, next: Next) => {
    for (const [key, value] of Object.entries(auth)) {
      c.set(key as never, value as never);
    }
    await next();
  });
  // A middleware that answers first, like a rate limiter.
  v1.use("/limited/*", (c: Context) =>
    v1Error(c, "RATE_LIMITED", "Slow down"),
  );
  // A real mounted route: the allowlist keeps only routes the app serves.
  v1.get("/built-in-tools/:builtInToolId/definitions", (c) =>
    c.json({ ok: true }),
  );
  v1.get("/missing/:id", (c) => v1Error(c, "NOT_FOUND", "No such thing"));
  v1.get("/boom", () => {
    throw new Error("kaboom secret detail");
  });
  v1.get("/limited/:id", (c) => c.json({ ok: true }));
  v1.post("/stream", (c) =>
    c.body("data: hi\n\n", 200, { "content-type": "text/event-stream" }),
  );
  v1.onError((e, c) => v1OnError(e, c));
  app.route("/api/v1", v1);
  app.get("/api/web/other", (c) => c.json({ ok: true }));
  return app;
}

function captured(): Record<string, any> {
  expect(captureMock).toHaveBeenCalledTimes(1);
  return captureMock.mock.calls[0][0];
}

describe("api_v1_request_completed", () => {
  beforeEach(() => {
    captureMock.mockClear();
    hosted.value = true;
    delete process.env.DO_NOT_TRACK;
    delete process.env.VITE_DISABLE_POSTHOG_LOCAL;
  });

  it("records a worker call by the token's user, with the declared client", async () => {
    const app = createApp({
      authMethod: "unverified_passthrough",
      analyticsUserId: WORKER_USER,
    });
    const res = await app.request("/api/v1/built-in-tools/p_123/definitions?secret=1", {
      headers: {
        "user-agent": "mcpjam-mcp-worker/0.2.0 mcpjam-sdk/1.0.0",
        "x-mcpjam-client": JSON.stringify({
          kind: "mcp",
          client: "claude-code",
          version: "2.1.0",
        }),
      },
    });
    expect(res.status).toBe(200);

    const event = captured();
    expect(event.event).toBe("api_v1_request_completed");
    expect(event.distinctId).toBe(WORKER_USER);
    expect(event.properties).toMatchObject({
      method: "GET",
      operation: "GET /api/v1/built-in-tools/:builtInToolId/definitions",
      http_status: 200,
      outcome: "ok",
      streamed: false,
      auth_method: "unverified_passthrough",
      surface: "mcp",
      mcp_client: "claude-code",
      is_guest: false,
      deployment: "hosted",
    });
    expect(event.properties.duration_ms).toEqual(expect.any(Number));
    // No path values, query strings or raw user agent.
    expect(JSON.stringify(event.properties)).not.toMatch(
      /p_123|secret|mcpjam-mcp-worker/,
    );

    // And every field survives the transport's allowlist.
    expectTelemetryFields(
      {
        analytics: event.event,
        actorId: event.distinctId,
        properties: event.properties,
      },
      [
        "method",
        "operation",
        "http_status",
        "outcome",
        "duration_ms",
        "streamed",
        "auth_method",
        "surface",
        "mcp_client",
        "is_guest",
      ],
    );
  });

  it("names an unrecognized agent other, never its own text", async () => {
    const app = createApp({ authMethod: "workos_api_key", workosUserId: WORKER_USER });
    await app.request("/api/v1/built-in-tools/p/definitions", {
      headers: {
        "x-mcpjam-client": JSON.stringify({ kind: "mcp", client: "Acme Bot" }),
      },
    });
    expect(captured().properties.mcp_client).toBe("other");
  });

  it("records the error code of a declared failure", async () => {
    const app = createApp({ authMethod: "workos_api_key", workosUserId: "user_1" });
    const res = await app.request("/api/v1/missing/x");
    expect(res.status).toBe(404);
    expect(captured().properties).toMatchObject({
      operation: "GET /api/v1/missing/:id",
      http_status: 404,
      outcome: "client_error",
      error_code: "NOT_FOUND",
      surface: "api",
    });
  });

  it("records a thrown error as the status the caller got, without its message", async () => {
    const app = createApp({ authMethod: "workos_api_key", workosUserId: "user_1" });
    const res = await app.request("/api/v1/boom");
    expect(res.status).toBe(500);
    const event = captured();
    expect(event.properties).toMatchObject({
      http_status: 500,
      outcome: "server_error",
    });
    expect(JSON.stringify(event.properties)).not.toContain("kaboom");
  });

  it("names the route a middleware refusal was aimed at", async () => {
    const app = createApp({ authMethod: "workos_api_key", workosUserId: "user_1" });
    const res = await app.request("/api/v1/limited/abc");
    expect(res.status).toBe(429);
    expect(captured().properties).toMatchObject({
      operation: "GET /api/v1/limited/:id",
      error_code: "RATE_LIMITED",
    });
  });

  it("records a stream when it opens", async () => {
    const app = createApp({ authMethod: "authkit_jwt", workosUserId: "user_1" });
    const res = await app.request("/api/v1/stream", { method: "POST" });
    await res.text();
    expect(captured().properties).toMatchObject({
      operation: "POST /api/v1/stream",
      streamed: true,
    });
  });

  it("records guests by guest id", async () => {
    const app = createApp({ authMethod: "guest", guestId: "guest_9" });
    await app.request("/api/v1/built-in-tools/p/definitions");
    const event = captured();
    expect(event.distinctId).toBe("guest_9");
    expect(event.properties.is_guest).toBe(true);
  });

  it("carries the organization an API key is bound to", async () => {
    const app = createApp({
      authMethod: "workos_api_key",
      workosUserId: "user_1",
      mcpjamOrganizationId: "org_1",
    });
    await app.request("/api/v1/built-in-tools/p/definitions");
    expect(captured().properties.organization_id).toBe("org_1");
  });

  it("drops a request with no identity", async () => {
    await createApp({}).request("/api/v1/built-in-tools/p/definitions");
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("sends nothing from a self-hosted server", async () => {
    hosted.value = false;
    await createApp({ workosUserId: "user_1" }).request("/api/v1/built-in-tools/p/definitions");
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("ignores routes outside /api/v1", async () => {
    await createApp({ workosUserId: "user_1" }).request("/api/web/other");
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("uses a batching PostHog client", async () => {
    await createApp({ workosUserId: "user_1" }).request("/api/v1/built-in-tools/p/definitions");
    expect(posthogOptions.at(-1)).toMatchObject({ flushAt: 20 });
  });
});

describe("resolveSurface", () => {
  it.each([
    ["mcp", undefined, "mcp"],
    ["cli", undefined, "cli"],
    ["github_action", undefined, "cli"],
    [undefined, "my-app/1 mcpjam-sdk/1.2.0", "sdk"],
    [undefined, "curl/8.0", "api"],
    [undefined, undefined, "api"],
  ])("kind %s, user agent %s → %s", (kind, ua, expected) => {
    expect(resolveSurface(kind, ua)).toBe(expected);
  });
});
