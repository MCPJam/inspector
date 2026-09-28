/**
 * MJ-020, MJ-021: what a hosted `500 INTERNAL_ERROR` says, on both surfaces.
 *
 * A generic sentence and the request id — the same id as the `x-request-id`
 * header — and nothing from the failure. The original message is still
 * recorded server-side, by the request log, under that id. A local inspector
 * keeps the message.
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

const { requestLogContextMiddleware } =
  await import("../../../middleware/request-log-context.js");
const { handleRoute } = await import("../auth.js");
const { mapWebBoundaryError } = await import("../boundary-error.js");
const { ErrorCode, WebRouteError, webErrorFromRoute } =
  await import("../errors.js");
const { v1Error, v1OnError } = await import("../../v1/envelope.js");
const { logger } = await import("../../../utils/logger.js");

const INTERNAL_DETAIL =
  "UNEXPECTED_MARKER [Request ID: 4f2a] Uncaught Error at handler (convex/internal.ts:12)";
const REQUEST_ID = "req-hosted-500-check";

function webApp(options: { requestLog?: boolean } = {}) {
  const app = new Hono();
  if (options.requestLog !== false) {
    app.use("*", requestLogContextMiddleware);
  }
  app.get("/api/web/handled", (c) =>
    handleRoute(c, async () => {
      throw new Error(INTERNAL_DETAIL);
    }),
  );
  app.get("/api/web/thrown", () => {
    throw new Error(INTERNAL_DETAIL);
  });
  app.get("/api/web/not-found", (c) =>
    handleRoute(c, async () => {
      throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Server not found");
    }),
  );
  app.onError((error, c) => webErrorFromRoute(c, mapWebBoundaryError(error)));
  return app;
}

function v1App() {
  const app = new Hono();
  app.use("*", requestLogContextMiddleware);
  app.get("/api/v1/thrown", () => {
    throw new Error(INTERNAL_DETAIL);
  });
  app.get("/api/v1/returned", (c) =>
    v1Error(c, "INTERNAL_ERROR", INTERNAL_DETAIL, {
      createdResources: [{ kind: "server", id: "srv-1" }],
    }),
  );
  app.onError((error, c) => v1OnError(error, c));
  return app;
}

function get(app: Hono, path: string) {
  return app.request(path, { headers: { "x-request-id": REQUEST_ID } });
}

/** Every `http.request.failed` row the request log emitted. */
function failedRows(spy: ReturnType<typeof vi.spyOn>) {
  return spy.mock.calls
    .filter(([name]) => name === "http.request.failed")
    .map(([, , payload]) => payload as Record<string, unknown>);
}

describe("hosted 500 INTERNAL_ERROR on /api/web", () => {
  let eventSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    config.hosted = true;
    eventSpy = vi.spyOn(logger, "event").mockImplementation(() => {});
    vi.spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["/api/web/handled", "/api/web/thrown"])(
    "%s answers with a generic sentence and the request id",
    async (path) => {
      const response = await get(webApp(), path);

      expect(response.status).toBe(500);
      expect(response.headers.get("x-request-id")).toBe(REQUEST_ID);
      const text = await response.text();
      expect(text).not.toContain("UNEXPECTED_MARKER");
      expect(text).not.toContain("Request ID: 4f2a");
      expect(text).not.toContain("convex/internal.ts");

      const body = JSON.parse(text);
      expect(body.code).toBe("INTERNAL_ERROR");
      expect(body.message).toContain(REQUEST_ID);
      expect(body.details).toEqual({ requestId: REQUEST_ID });
      expect(body.normalized.requestId).toBe(REQUEST_ID);
      expect(body.normalized.rawMessage).toBe(body.message);
      expect(body.normalized.oneLine).toBe(body.message);
      expect(body.normalized.cause).toBeUndefined();
    },
  );

  it("keeps the original message in the request log, under the same id", async () => {
    await get(webApp(), "/api/web/handled");

    const [row] = failedRows(eventSpy);
    expect(row).toMatchObject({ statusCode: 500, errorCode: "INTERNAL_ERROR" });
    expect(String(row?.errorMessage)).toContain("UNEXPECTED_MARKER");
    const [, base] = eventSpy.mock.calls.find(
      ([name]) => name === "http.request.failed",
    )!;
    expect((base as { requestId?: string }).requestId).toBe(REQUEST_ID);
  });

  it("mints a request id, sets the header and logs the message when no request log runs", async () => {
    const warn = vi.mocked(logger.warn);

    const response = await webApp({ requestLog: false }).request(
      "/api/web/handled",
    );

    expect(response.status).toBe(500);
    const requestId = response.headers.get("x-request-id");
    expect(requestId).toBeTruthy();
    const body = await response.json();
    expect(body.details.requestId).toBe(requestId);
    expect(JSON.stringify(body)).not.toContain("UNEXPECTED_MARKER");
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain(requestId);
    expect(logged).toContain("UNEXPECTED_MARKER");
  });

  it("leaves a deliberate 4xx exactly as the route wrote it", async () => {
    const response = await get(webApp(), "/api/web/not-found");

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).toMatchObject({
      code: "NOT_FOUND",
      message: "Server not found",
    });
    expect(body.details).toBeUndefined();
  });

  it("keeps the message outside hosted mode", async () => {
    config.hosted = false;

    const response = await get(webApp(), "/api/web/handled");

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.message).toBe(INTERNAL_DETAIL);
    expect(body.details).toBeUndefined();
  });
});

describe("hosted INTERNAL_ERROR on /api/v1", () => {
  let eventSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    config.hosted = true;
    eventSpy = vi.spyOn(logger, "event").mockImplementation(() => {});
    vi.spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("answers a thrown failure with a generic sentence and details.requestId", async () => {
    const response = await get(v1App(), "/api/v1/thrown");

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("UNEXPECTED_MARKER");
    expect(text).not.toContain("convex/internal.ts");
    const body = JSON.parse(text);
    expect(body).toEqual({
      code: "INTERNAL_ERROR",
      message: expect.stringContaining(REQUEST_ID),
      details: { requestId: REQUEST_ID },
    });

    const [row] = failedRows(eventSpy);
    expect(String(row?.errorMessage)).toContain("UNEXPECTED_MARKER");
  });

  it("keeps the route's structured details beside the request id", async () => {
    const response = await get(v1App(), "/api/v1/returned");

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.message).not.toContain("UNEXPECTED_MARKER");
    expect(body.details).toEqual({
      createdResources: [{ kind: "server", id: "srv-1" }],
      requestId: REQUEST_ID,
    });
  });

  it("keeps the message outside hosted mode", async () => {
    config.hosted = false;

    const response = await get(v1App(), "/api/v1/thrown");

    const body = await response.json();
    expect(body.message).toBe(INTERNAL_DETAIL);
    expect(body.details).toBeUndefined();
  });
});
