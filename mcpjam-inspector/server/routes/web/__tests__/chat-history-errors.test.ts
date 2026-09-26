/**
 * MJ-020, MJ-021: the chat-history proxy answers a backend failure with the
 * backend's status, a recognized code, and its own words.
 *
 * Unlike `chat-history.test.ts`, nothing here is mocked between the route and
 * the response: the real `handleRoute`, the real error mapper and the real
 * envelope, so what is asserted is what a caller would receive.
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
const { default: chatHistory } = await import("../chat-history.js");
const { mapWebBoundaryError } = await import("../boundary-error.js");
const { webErrorFromRoute } = await import("../errors.js");
const { logger } = await import("../../../utils/logger.js");

const REQUEST_ID = "req-chat-history-check";

/** A backend error body carrying Convex argument-validation output. */
const VALIDATOR_OUTPUT = [
  "[Request ID: 9c1e] Server Error",
  "Uncaught ArgumentValidationError: Value does not match validator.",
  "Path: .uiType",
  'Value: "UNEXPECTED_MARKER"',
  'Validator: v.union(v.literal("mcp-apps"), v.literal("openai-apps"))',
].join("\n");

const WIDGET_SNAPSHOT_BODY = {
  chatSessionId: "chat-1",
  toolCallId: "call-1",
  toolName: "render_widget",
  serverId: "srv-1",
  widgetHtmlBlobId: "blob-1",
  uiType: "UNEXPECTED_MARKER",
};

const fetchMock = vi.fn();

function createApp() {
  const app = new Hono();
  app.use("*", requestLogContextMiddleware);
  app.route("/api/web/chat-history", chatHistory);
  app.onError((error, c) => webErrorFromRoute(c, mapWebBoundaryError(error)));
  return app;
}

function backendAnswers(status: number, body: Record<string, unknown>) {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function post(path: string, body: Record<string, unknown>) {
  return createApp().request(`/api/web/chat-history${path}`, {
    method: "POST",
    headers: {
      Authorization: "Bearer test-token",
      "Content-Type": "application/json",
      "x-request-id": REQUEST_ID,
    },
    body: JSON.stringify(body),
  });
}

/** Status line aside, everything a caller can read off the response. */
async function everythingIn(response: Response): Promise<string> {
  const headers: string[] = [];
  response.headers.forEach((value, name) => headers.push(`${name}: ${value}`));
  return `${headers.join("\n")}\n${await response.text()}`;
}

describe("chat-history backend failures", () => {
  beforeEach(() => {
    config.hosted = true;
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
    vi.spyOn(logger, "event").mockImplementation(() => {});
    vi.spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([
    [400, "VALIDATION_ERROR"],
    [500, "INTERNAL_ERROR"],
  ])(
    "answers a widget snapshot the backend rejected (%s) without any of its text",
    async (status, code) => {
      backendAnswers(status, { ok: false, error: VALIDATOR_OUTPUT });

      const response = await post(
        "/widget-snapshot/create",
        WIDGET_SNAPSHOT_BODY,
      );

      expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
        "https://convex.test/direct-chat/widget-snapshot/create",
      );
      expect(response.status).toBe(status);
      const everything = await everythingIn(response.clone());
      expect(everything).not.toContain("Validator:");
      expect(everything).not.toContain("ArgumentValidationError");
      expect(everything).not.toContain("UNEXPECTED_MARKER");
      expect(everything).not.toContain("Request ID: 9c1e");
      expect((await response.json()).code).toBe(code);
    },
  );

  it("points a hosted 500 at the request id instead", async () => {
    backendAnswers(500, { ok: false, error: VALIDATOR_OUTPUT });

    const response = await post(
      "/widget-snapshot/create",
      WIDGET_SNAPSHOT_BODY,
    );

    const body = await response.json();
    expect(body.message).toContain(REQUEST_ID);
    expect(body.details).toEqual({ requestId: REQUEST_ID });
  });

  it("logs the backend text it does not return", async () => {
    backendAnswers(400, { ok: false, error: VALIDATOR_OUTPUT });

    await post("/widget-snapshot/create", WIDGET_SNAPSHOT_BODY);

    const logged = JSON.stringify(vi.mocked(logger.warn).mock.calls);
    expect(logged).toContain("UNEXPECTED_MARKER");
  });

  it("answers a refused chat action with 403", async () => {
    backendAnswers(403, {
      ok: false,
      error: "Access denied: UNEXPECTED_MARKER owner mismatch",
    });

    const response = await post("/action", {
      action: "archive",
      sessionId: "session-1",
    });

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body).toMatchObject({
      code: "FORBIDDEN",
      message: "You do not have access to this chat.",
    });
    expect(JSON.stringify(body)).not.toContain("UNEXPECTED_MARKER");
  });

  it("relays a code a caller can branch on", async () => {
    backendAnswers(429, {
      ok: false,
      code: "RATE_LIMITED",
      error: "UNEXPECTED_MARKER budget exhausted",
    });

    const response = await post("/widget-snapshot/generate-upload-url", {
      chatSessionId: "chat-1",
    });

    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body).toMatchObject({
      code: "RATE_LIMITED",
      message: "Too many requests. Wait a moment and try again.",
    });
  });

  it("derives the code from the status when the backend's is not recognized", async () => {
    backendAnswers(409, {
      ok: false,
      code: "UNEXPECTED_MARKER_CODE",
      error: "stale",
    });

    const response = await post("/action", {
      action: "rename",
      sessionId: "session-1",
    });

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe("CONFLICT");
    expect(JSON.stringify(body)).not.toContain("UNEXPECTED_MARKER");
  });

  it("maps reads the same way", async () => {
    backendAnswers(404, {
      ok: false,
      error: "Session UNEXPECTED_MARKER not found in table chatSessions",
    });

    const response = await createApp().request(
      "/api/web/chat-history/detail?chatSessionId=chat-1",
      { headers: { Authorization: "Bearer test-token" } },
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).toMatchObject({
      code: "NOT_FOUND",
      message: "Chat not found.",
    });
    expect(JSON.stringify(body)).not.toContain("UNEXPECTED_MARKER");
  });

  it("keeps the backend's text outside hosted mode", async () => {
    config.hosted = false;
    backendAnswers(404, { ok: false, error: "Session not found" });

    const response = await post("/action", {
      action: "pin",
      sessionId: "session-1",
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      code: "NOT_FOUND",
      message: "Session not found",
    });
  });
});
