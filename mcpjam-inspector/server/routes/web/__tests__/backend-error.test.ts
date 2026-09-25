/**
 * MJ-020, MJ-021: a route that relays a failed answer from MCPJam's own
 * backend keeps the backend's status and a recognized code, and — hosted —
 * answers in its own words, logging the backend's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const config = vi.hoisted(() => ({ hosted: true }));

vi.mock("../../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../config.js")>();
  return {
    ...actual,
    get HOSTED_MODE() {
      return config.hosted;
    },
  };
});

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

const { backendFailureRouteError } = await import("../backend-error.js");
const { ErrorCode, webErrorFromRoute } = await import("../errors.js");
const { mapWebBoundaryError } = await import("../boundary-error.js");
const { default: caniuseRoutes } = await import("../caniuse.js");
const { default: scoreRoutes } = await import("../score.js");
const { logger } = await import("../../../utils/logger.js");

const BACKEND_TEXT =
  "[Request ID: 51aa] Server Error\nUncaught Error: UNEXPECTED_MARKER at storeReport (convex/caniuse.ts:88)";

function createApp() {
  const app = new Hono();
  app.route("/api/web/caniuse", caniuseRoutes);
  app.route("/api/web/score", scoreRoutes);
  app.onError((error, c) => webErrorFromRoute(c, mapWebBoundaryError(error)));
  return app;
}

function backendAnswers(status: number, body: Record<string, unknown>) {
  vi.mocked(global.fetch).mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

describe("backendFailureRouteError", () => {
  beforeEach(() => {
    config.hosted = true;
    vi.spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    [400, ErrorCode.VALIDATION_ERROR],
    [401, ErrorCode.UNAUTHORIZED],
    [403, ErrorCode.FORBIDDEN],
    [404, ErrorCode.NOT_FOUND],
    [409, ErrorCode.CONFLICT],
    [413, ErrorCode.VALIDATION_ERROR],
    [429, ErrorCode.RATE_LIMITED],
    [500, ErrorCode.INTERNAL_ERROR],
    [503, ErrorCode.INTERNAL_ERROR],
  ])("keeps a %s and answers %s", (status, code) => {
    const error = backendFailureRouteError({
      source: "test",
      status,
      body: { ok: false, error: BACKEND_TEXT },
      message: "Request failed.",
    });
    expect(error.status).toBe(status);
    expect(error.code).toBe(code);
    expect(error.message).toBe("Request failed.");
  });

  it("answers 502 for a status that is not a failure", () => {
    const error = backendFailureRouteError({
      source: "test",
      status: 200,
      body: { ok: false },
      message: "Request failed.",
    });
    expect(error.status).toBe(502);
  });

  it("relays a recognized backend code and ignores any other", () => {
    const relayed = backendFailureRouteError({
      source: "test",
      status: 400,
      body: { ok: false, code: "RATE_LIMITED" },
      message: "Request failed.",
    });
    expect(relayed.code).toBe(ErrorCode.RATE_LIMITED);

    const derived = backendFailureRouteError({
      source: "test",
      status: 400,
      body: { ok: false, code: "UNEXPECTED_MARKER" },
      message: "Request failed.",
    });
    expect(derived.code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it("logs the backend's text instead of returning it", () => {
    backendFailureRouteError({
      source: "test",
      status: 500,
      body: { ok: false, error: BACKEND_TEXT },
      message: "Request failed.",
    });
    const [message, context] = vi.mocked(logger.warn).mock.calls[0] ?? [];
    expect(message).toContain("[test]");
    expect(context).toMatchObject({ status: 500 });
    expect(String((context as { detail?: unknown }).detail)).toContain(
      "UNEXPECTED_MARKER",
    );
  });

  it("returns the backend's text outside hosted mode", () => {
    config.hosted = false;
    const error = backendFailureRouteError({
      source: "test",
      status: 401,
      body: { ok: false, error: "Unauthorized" },
      message: "Request failed.",
    });
    expect(error.message).toBe("Unauthorized");
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("caniuse and score relays", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    config.hosted = true;
    global.fetch = vi.fn();
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "svc-token");
    vi.spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("answers a rejected report in the route's words", async () => {
    backendAnswers(400, { ok: false, error: BACKEND_TEXT });

    const response = await createApp().request(
      "/api/web/caniuse/report-inconsistency",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-real-ip": "192.0.2.90",
        },
        body: JSON.stringify({ message: "The table looks wrong." }),
      },
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toMatchObject({
      code: "SERVER_UNREACHABLE",
      message: "Failed to store report",
    });
    expect(JSON.stringify(body)).not.toContain("UNEXPECTED_MARKER");
  });

  it("answers a failed subscription in the route's words", async () => {
    backendAnswers(500, { ok: false, error: BACKEND_TEXT });

    const response = await createApp().request("/api/web/caniuse/subscribe", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-real-ip": "192.0.2.91",
      },
      body: JSON.stringify({ email: "reader@example.com" }),
    });

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.message).toBe("Failed to save subscription");
    expect(JSON.stringify(body)).not.toContain("UNEXPECTED_MARKER");
  });

  it("answers a failed score read in the route's words", async () => {
    backendAnswers(500, { ok: false, error: BACKEND_TEXT });

    const response = await createApp().request(
      "/api/web/score/runs/tok_unexpected",
      { headers: { "x-real-ip": "192.0.2.92" } },
    );

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toMatchObject({
      code: "SERVER_UNREACHABLE",
      message: "Failed to load score run",
    });
    expect(JSON.stringify(body)).not.toContain("UNEXPECTED_MARKER");
  });
});
