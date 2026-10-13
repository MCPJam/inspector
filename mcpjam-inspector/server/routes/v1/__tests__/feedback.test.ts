import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// Covers the v1 FEEDBACK surface (server/routes/v1/feedback.ts): auth + guest
// gating, the strict body schema, the STRICT idempotency-key header (a key
// that is present but unusable is a 400, never silently dropped), what is
// forwarded to Convex, the error contract, and the receipt DTO.
//
// Convex is mocked at the `convex/browser` boundary, so these prove the
// gateway's behavior and the ARGS it forwards, NOT that the backend accepts
// them. The backend's own caps, dedupe, key replay and rate limit are covered
// by mcpjam-backend/tests/convex/platformFeedback.test.ts.

const {
  validateGuestTokenMock,
  validateApiKeyMock,
  resolveUserByExternalIdMock,
  lookupWorkosKeyBindingMock,
  convexQueryMock,
  convexMutationMock,
} = vi.hoisted(() => ({
  validateGuestTokenMock: vi.fn(),
  validateApiKeyMock: vi.fn(),
  resolveUserByExternalIdMock: vi.fn(),
  lookupWorkosKeyBindingMock: vi.fn(),
  convexQueryMock: vi.fn(),
  convexMutationMock: vi.fn(),
}));

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenMock,
}));

vi.mock("../../../services/workos-client.js", () => ({
  getWorkOSClient: () => ({
    apiKeys: { createValidation: validateApiKeyMock },
  }),
}));
vi.mock("../../../services/identity.js", () => ({
  resolveUserByExternalId: resolveUserByExternalIdMock,
}));
vi.mock("../../../services/workos-key-bindings.js", () => ({
  lookupWorkosKeyBinding: lookupWorkosKeyBindingMock,
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn().mockImplementation(function () {
    return {
      setAuth: vi.fn(),
      query: convexQueryMock,
      mutation: convexMutationMock,
    };
  }),
}));

import v1Routes from "../index.js";
import { logger } from "../../../utils/logger.js";

function makeApp(): Hono {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return app;
}

function send(
  opts: {
    body?: unknown;
    token?: string | null;
    headers?: Record<string, string>;
  } = {}
): Promise<Response> {
  const { body = VALID_BODY, token = "tok", headers = {} } = opts;
  const allHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...headers,
  };
  if (token) allHeaders.Authorization = `Bearer ${token}`;
  return Promise.resolve(
    makeApp().request("/api/v1/feedback", {
      method: "POST",
      headers: allHeaders,
      body: JSON.stringify(body),
    })
  );
}

const VALID_BODY = {
  kind: "bug",
  summary: "the eval run page crashes",
};

const RECEIPT = { id: "fb_1", receivedAt: 1_750_000_000_000, duplicate: false };

/** A structured Convex refusal, the way the backend raises one. */
function convexError(data: Record<string, unknown>) {
  return Object.assign(
    new Error(`Uncaught ConvexError: ${String(data.message ?? data.code)}`),
    { data }
  );
}

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe("POST /v1/feedback", () => {
  const originalEnv = {
    CONVEX_URL: process.env.CONVEX_URL,
    CONVEX_HTTP_URL: process.env.CONVEX_HTTP_URL,
  };
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_URL = "https://convex.example.com";
    process.env.CONVEX_HTTP_URL = "https://convex-http.example.com";
    validateGuestTokenMock.mockResolvedValue({ valid: false });
    convexMutationMock.mockResolvedValue(RECEIPT);
    warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value) process.env[key] = value;
      else delete process.env[key];
    }
    warnSpy.mockRestore();
  });

  describe("auth", () => {
    it("rejects a request with no bearer token (401)", async () => {
      const res = await send({ token: null });
      expect(res.status).toBe(401);
      expect((await bodyOf(res)).code).toBe("UNAUTHORIZED");
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("denies guest callers — feedback needs an account", async () => {
      validateGuestTokenMock.mockResolvedValue({
        valid: true,
        guestId: "guest_1",
      });
      const res = await send({ token: "guest-jwt" });
      expect(res.status).toBe(401);
      expect((await bodyOf(res)).code).toBe("UNAUTHORIZED");
      expect(convexMutationMock).not.toHaveBeenCalled();
    });
  });

  describe("the body", () => {
    it.each([
      ["an unknown key", { ...VALID_BODY, source: "app" }],
      ["an unknown kind", { ...VALID_BODY, kind: "praise" }],
      ["a missing summary", { kind: "bug" }],
      ["a blank summary", { ...VALID_BODY, summary: "   " }],
      ["an over-long summary", { ...VALID_BODY, summary: "x".repeat(201) }],
      ["over-long details", { ...VALID_BODY, details: "x".repeat(8001) }],
      ["an over-long operation", { ...VALID_BODY, operation: "x".repeat(121) }],
      ["an over-long requestId", { ...VALID_BODY, requestId: "x".repeat(129) }],
      ["an over-long errorCode", { ...VALID_BODY, errorCode: "x".repeat(65) }],
      // The declared origin is the SERVER's to stamp (`source`) or a header's
      // to declare (`launcher`); neither is a body field.
      ["a launcher in the body", { ...VALID_BODY, launcher: { kind: "cli" } }],
    ])("rejects %s with a 400", async (_name, body) => {
      const res = await send({ body });
      expect(res.status).toBe(400);
      expect((await bodyOf(res)).code).toBe("VALIDATION_ERROR");
      expect(convexMutationMock).not.toHaveBeenCalled();
    });
  });

  describe("the idempotency-key header", () => {
    it.each([
      ["an empty idempotency-key", { "idempotency-key": "   " }],
      [
        "an empty x-mcpjam-idempotency-key",
        { "x-mcpjam-idempotency-key": "" },
      ],
      ["an oversized key", { "idempotency-key": "k".repeat(257) }],
      [
        "two headers with different keys",
        { "idempotency-key": "key-a", "x-mcpjam-idempotency-key": "key-b" },
      ],
    ])("rejects %s with a 400 naming the header", async (_name, headers) => {
      const res = await send({ headers });
      expect(res.status).toBe(400);
      const body = await bodyOf(res);
      expect(body.code).toBe("VALIDATION_ERROR");
      expect(String(body.message)).toMatch(/idempotency-key/);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("accepts the same key on both headers", async () => {
      const res = await send({
        headers: {
          "idempotency-key": "key-a",
          "x-mcpjam-idempotency-key": " key-a ",
        },
      });
      expect(res.status).toBe(201);
      expect(convexMutationMock.mock.calls[0]![1]).toMatchObject({
        idempotencyKey: "key-a",
      });
    });
  });

  describe("forwarding", () => {
    it("forwards the report, the key and the declared launcher; stamps source api", async () => {
      const res = await send({
        body: {
          kind: "missing_capability",
          summary: "  cannot export a suite  ",
          details: "Wanted YAML; no export tool exists.",
          operation: "list_eval_suites",
          requestId: "req_0123456789abcdef",
          errorCode: "FEATURE_NOT_SUPPORTED",
          projectId: "proj_1",
        },
        headers: {
          "idempotency-key": "key-a",
          "x-mcpjam-launcher": JSON.stringify({
            kind: "mcp",
            client: "claude-code",
            version: "2.1.0",
          }),
        },
      });
      expect(res.status).toBe(201);
      expect(convexMutationMock).toHaveBeenCalledWith(
        "platformFeedback:submit",
        {
          kind: "missing_capability",
          summary: "cannot export a suite",
          details: "Wanted YAML; no export tool exists.",
          operation: "list_eval_suites",
          requestId: "req_0123456789abcdef",
          errorCode: "FEATURE_NOT_SUPPORTED",
          projectId: "proj_1",
          source: "api",
          launcher: { kind: "mcp", client: "claude-code", version: "2.1.0" },
          idempotencyKey: "key-a",
        }
      );
    });

    it("reads the key off the prefixed header too", async () => {
      await send({ headers: { "x-mcpjam-idempotency-key": "key-b" } });
      expect(convexMutationMock.mock.calls[0]![1]).toMatchObject({
        idempotencyKey: "key-b",
      });
    });

    it("sends only what was given: no key, no launcher, no empty optionals", async () => {
      await send({ body: { ...VALID_BODY, details: "   " } });
      expect(convexMutationMock).toHaveBeenCalledWith(
        "platformFeedback:submit",
        { kind: "bug", summary: "the eval run page crashes", source: "api" }
      );
    });
  });

  describe("the receipt", () => {
    it("answers 201 with exactly {id, receivedAt, duplicate}", async () => {
      convexMutationMock.mockResolvedValue({
        id: "fb_9",
        receivedAt: 1_750_000_000_123,
        duplicate: true,
      });
      const res = await send();
      expect(res.status).toBe(201);
      expect(await bodyOf(res)).toEqual({
        id: "fb_9",
        receivedAt: 1_750_000_000_123,
        duplicate: true,
      });
    });
  });

  describe("errors", () => {
    it("maps NOT_FOUND to a 404 that names nothing", async () => {
      convexMutationMock.mockRejectedValue(
        convexError({ code: "NOT_FOUND", message: "Project not found" })
      );
      const res = await send({ body: { ...VALID_BODY, projectId: "proj_x" } });
      expect(res.status).toBe(404);
      expect(await bodyOf(res)).toMatchObject({
        code: "NOT_FOUND",
        message: "Project not found",
      });
    });

    it("maps CONFLICT (key reused for different content) to a 409", async () => {
      convexMutationMock.mockRejectedValue(
        convexError({
          code: "CONFLICT",
          message: "This idempotency key was already used for different feedback.",
        })
      );
      const res = await send({ headers: { "idempotency-key": "key-a" } });
      expect(res.status).toBe(409);
      expect((await bodyOf(res)).code).toBe("CONFLICT");
    });

    it("maps rate_limited to a 429 with Retry-After", async () => {
      convexMutationMock.mockRejectedValue(
        convexError({
          code: "rate_limited",
          message: "You've sent a lot of feedback recently.",
          category: "platformFeedback",
          retryAfterMs: 90_000,
        })
      );
      const res = await send();
      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBe("90");
      expect((await bodyOf(res)).code).toBe("RATE_LIMITED");
    });

    it("maps a backend VALIDATION refusal to a 400 with its message", async () => {
      convexMutationMock.mockRejectedValue(
        convexError({
          code: "VALIDATION",
          message: "summary must be at most 200 characters.",
        })
      );
      const res = await send();
      expect(res.status).toBe(400);
      expect(await bodyOf(res)).toMatchObject({
        code: "VALIDATION_ERROR",
        message: "summary must be at most 200 characters.",
      });
    });
  });
});
