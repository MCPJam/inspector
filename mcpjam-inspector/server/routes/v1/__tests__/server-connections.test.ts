/**
 * The public REST surface for connecting a server.
 *
 * These four routes are thin — they forward the caller's own bearer and return
 * what the backend says — so the part worth pinning is the TRANSLATION. The
 * backend raises a vocabulary the generic v1 mapper does not know
 * (`ACTIVE_REQUEST_LIMIT`, `AMBIGUOUS_SERVER`), and the
 * generic fallback flattens all of it into a 400: "fix your input", when the
 * honest answer is "wait", "finish one you already started", or "this is not on
 * yet". `CODE_MAP` is also the piece most likely to drift, because a new backend
 * code appears silently as a 500 rather than as a failure anyone notices.
 *
 * The other assertion here is the guest polling budget. The status route is
 * meant to be polled every few seconds while someone authorizes in a browser,
 * and it used to spend the shared 60-per-minute guest bucket doing it — so
 * following the flow correctly could 429 a guest out of the flow.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const convex = vi.hoisted(() => ({
  action: vi.fn(),
  query: vi.fn(),
  mutation: vi.fn(),
  setAuth: vi.fn(),
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth = convex.setAuth;
    action = convex.action;
    query = convex.query;
    mutation = convex.mutation;
  },
}));

vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: vi.fn(async () => "bearer-token"),
}));

const { default: serverConnectionsV1 } = await import("../server-connections.js");
const { mapRuntimeError, webError } = await import("../../web/errors.js");
const { resetServerConnectionPollRateLimitForTests } = await import(
  "../../../middleware/server-connection-poll-rate-limit.js"
);

/** A Convex `ConvexError`-shaped rejection: the code rides on `.data`. */
function backendError(code: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error("backend refused"), {
    data: { code, message: `refused: ${code}`, ...extra },
  });
}

function createApp(): Hono {
  const app = new Hono();
  app.route("/api/v1", serverConnectionsV1);
  app.onError((error, c) => {
    const routeError = mapRuntimeError(error);
    return webError(
      c,
      routeError.status,
      routeError.code,
      routeError.message,
      routeError.details
    );
  });
  return app;
}

const create = (body: unknown, headers: Record<string, string> = {}) =>
  createApp().request("/api/v1/server-connections", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  // `convexClient` refuses to build without it, and would 500 every route.
  vi.stubEnv("CONVEX_URL", "https://convex.test");
  resetServerConnectionPollRateLimitForTests();
  convex.action.mockResolvedValue({
    connectionRequestId: "scr_1",
    status: "awaiting_project",
    handoffUrl: "https://app.mcpjam.test/connect/server/tok",
  });
});

afterEach(async () => {
  // Vitest does not restore stubbed env automatically, and `CONVEX_URL`
  // leaking into a neighbouring file would make it pass for the wrong reason.
  vi.unstubAllEnvs();
  // Both limiters are module singletons, so a test that throws mid-loop would
  // otherwise leave a warm bucket for whatever runs next. Restoring here rather
  // than at the end of a test body means it happens on failure too.
  resetServerConnectionPollRateLimitForTests();
  const { resetGuestRateLimitForTests } = await import(
    "../../../middleware/guest-rate-limit.js"
  );
  resetGuestRateLimitForTests();
});

describe("create", () => {
  it("forwards the request and answers 201", async () => {
    const res = await create({ url: "https://example.com/mcp" });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { connectionRequestId: string };
    expect(body.connectionRequestId).toBe("scr_1");
    expect(convex.action).toHaveBeenCalledWith(
      "serverConnectionsPublic:createConnection",
      expect.objectContaining({
        url: "https://example.com/mcp",
        sourceSurface: "api",
      })
    );
  });

  it("keys the guest budget on the trusted client IP", async () => {
    await create(
      { url: "https://example.com/mcp" },
      // `x-real-ip` is set by the trusted proxy; `x-forwarded-for` is
      // client-mutable, so a caller must not be able to pick their own bucket
      // by rotating it.
      { "x-real-ip": "203.0.113.10", "x-forwarded-for": "198.51.100.1" }
    );

    expect(convex.action).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ clientIpKey: "203.0.113.10" })
    );
  });

  it("charges an unplaceable caller to a shared bucket rather than exempting them", async () => {
    await create({ url: "https://example.com/mcp" });

    expect(convex.action).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ clientIpKey: "_unknown" })
    );
  });

  it("rejects invalid JSON", async () => {
    const res = await create("{not json");

    expect(res.status).toBe(400);
    expect(convex.action).not.toHaveBeenCalled();
  });

  it("rejects a body the schema does not accept", async () => {
    expect((await create({})).status).toBe(400);
    expect((await create({ url: "   " })).status).toBe(400);
    expect(
      (await create({ url: "https://example.com/mcp", extra: 1 })).status
    ).toBe(400);
    expect(convex.action).not.toHaveBeenCalled();
  });
});

describe("error translation", () => {
  it.each([
    ["REQUEST_NOT_FOUND", 404],
    ["REQUEST_EXPIRED", 409],
    ["INVALID_STATE", 409],
    ["ACTIVE_REQUEST_LIMIT", 409],
    ["RATE_LIMITED", 429],
    ["PROJECT_ACCESS_DENIED", 403],
    ["URL_NOT_ALLOWED", 400],
    ["UNSUPPORTED_AUTH_METHOD", 400],
  ])("maps %s to %i", async (code, status) => {
    convex.action.mockRejectedValue(backendError(code));

    const res = await create({ url: "https://example.com/mcp" });

    expect(res.status).toBe(status);
    const body = (await res.json()) as { details?: { code?: string } };
    expect(body.details?.code).toBe(code);
  });

  it("carries the candidates through an AMBIGUOUS_SERVER refusal", async () => {
    convex.action.mockRejectedValue(
      backendError("AMBIGUOUS_SERVER", {
        candidates: [
          { id: "srv_1", name: "one", url: "https://example.com/mcp" },
          { id: "srv_2", name: "two", url: "https://example.com/mcp" },
        ],
      })
    );

    const res = await create({ url: "https://example.com/mcp" });

    // Without the candidates the refusal is a dead end: the caller is told to
    // re-send with a serverId and has no way to learn which ones exist.
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      details?: { candidates?: Array<{ id: string }> };
    };
    expect(body.details?.candidates?.map((candidate) => candidate.id)).toEqual([
      "srv_1",
      "srv_2",
    ]);
  });

  it("carries the open request ids through an ACTIVE_REQUEST_LIMIT refusal", async () => {
    convex.action.mockRejectedValue(
      backendError("ACTIVE_REQUEST_LIMIT", {
        activeRequests: ["scr_1", "scr_2"],
      })
    );

    const res = await create({ url: "https://example.com/mcp" });

    // Same reason as the candidates above: the refusal says to finish or
    // cancel one, and these ids are what makes that possible for a caller
    // whose scrollback no longer has them.
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      details?: { activeRequests?: string[] };
    };
    expect(body.details?.activeRequests).toEqual(["scr_1", "scr_2"]);
  });

  it("falls back to 500 for a code it has never seen", async () => {
    // The drift case: a new backend code arrives as an opaque 500 rather than
    // as anything anyone notices. Pinned so the fallback stays deliberate.
    convex.action.mockRejectedValue(backendError("SOME_NEW_BACKEND_CODE"));

    const res = await create({ url: "https://example.com/mcp" });

    expect(res.status).toBe(500);
  });
});

describe("status, cancel and retry", () => {
  it("reads one request", async () => {
    convex.query.mockResolvedValue({ connectionRequestId: "scr_1", status: "ready" });

    const res = await createApp().request("/api/v1/server-connections/scr_1");

    expect(res.status).toBe(200);
    expect(convex.query).toHaveBeenCalledWith(
      "serverConnectionsPublic:getConnection",
      { connectionRequestId: "scr_1" }
    );
  });

  it("claims exactly the status path as carrying its own budget", async () => {
    const { hasDedicatedPollBudget } = await import(
      "../../../middleware/server-connection-poll-rate-limit.js"
    );

    // The exemption and the budget that replaces it must agree on the same
    // path, or the route either pays twice or is not metered at all.
    expect(
      hasDedicatedPollBudget("GET", "/api/v1/server-connections/scr_1")
    ).toBe(true);
    expect(
      hasDedicatedPollBudget("POST", "/api/v1/server-connections/scr_1/cancel")
    ).toBe(false);
    expect(hasDedicatedPollBudget("POST", "/api/v1/server-connections")).toBe(
      false
    );
  });

  it("polls without spending the shared guest bucket", async () => {
    const { guestRateLimitMiddleware } = await import(
      "../../../middleware/guest-rate-limit.js"
    );
    const { serverConnectionPollRateLimitMiddleware } = await import(
      "../../../middleware/server-connection-poll-rate-limit.js"
    );

    // Both limiters, in the order the v1 router applies them, with a guest.
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("guestId", "guest_1");
      await next();
    });
    app.use("*", guestRateLimitMiddleware);
    app.get(
      "/api/v1/server-connections/:id",
      serverConnectionPollRateLimitMiddleware,
      (c) => c.json({ ok: true })
    );
    app.get("/api/v1/projects", (c) => c.json({ ok: true }));

    // Well past the shared 60/min bucket. A guest watching their own
    // connection must not be locked out of the rest of the API for it.
    for (let i = 0; i < 100; i += 1) {
      expect(
        (await app.request("/api/v1/server-connections/scr_1")).status
      ).toBe(200);
    }
    expect((await app.request("/api/v1/projects")).status).toBe(200);
  });

  it("cancels", async () => {
    convex.mutation.mockResolvedValue({ status: "cancelled" });

    const res = await createApp().request(
      "/api/v1/server-connections/scr_1/cancel",
      { method: "POST" }
    );

    expect(res.status).toBe(200);
    expect(convex.mutation).toHaveBeenCalledWith(
      "serverConnectionsPublic:cancelConnection",
      { connectionRequestId: "scr_1" }
    );
  });

  it("translates a refusal on the status read too", async () => {
    convex.query.mockRejectedValue(backendError("REQUEST_NOT_FOUND"));

    const res = await createApp().request("/api/v1/server-connections/scr_x");

    expect(res.status).toBe(404);
  });
});
