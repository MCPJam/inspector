import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// CONVEX-33X arrived through this route: a suite file's judge written as
// `mcpjam/anthropic/claude-haiku-4.5` reached `resolveOrCreateFileOwnedSuite`
// verbatim and was refused. The suite settings PATCH and the per-run judge
// override are covered next to their existing tests in `eval-edit.test.ts`
// and `insights-envelope.test.ts`.

const { validateGuestTokenMock, convexQueryMock, convexMutationMock } =
  vi.hoisted(() => ({
    validateGuestTokenMock: vi.fn(),
    convexQueryMock: vi.fn(),
    convexMutationMock: vi.fn(),
  }));

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenMock,
}));
vi.mock("../../../utils/analytics.js", () => ({
  captureServerEvent: vi.fn(),
}));
// A plain class, not `vi.fn()`: `restoreAllMocks` in `afterEach` would reset a
// mocked constructor's implementation and leave later tests without a client.
vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth() {}
    query = convexQueryMock;
    mutation = convexMutationMock;
    action = vi.fn();
  },
}));

import v1Routes from "../index.js";
import { logger } from "../../../utils/logger.js";

const PROJECT_ID = "k57a1b2c3d4e5f6g7h8j9k0m1n2p3q4r";
const SUITE_ID = "s57a1b2c3d4e5f6g7h8j9k0m1n2p3q4r";

function syncSuite(judge: unknown) {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return app.request(`/api/v1/projects/${PROJECT_ID}/eval-suites/from-file`, {
    method: "POST",
    headers: {
      Authorization: "Bearer tok",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      declaredSuiteId: "checkout-suite",
      name: "Checkout",
      sourceHash: "a".repeat(64),
      ...(judge === undefined ? {} : { judge }),
    }),
  });
}

function judgeSent(): unknown {
  const call = convexMutationMock.mock.calls.find(
    ([name]) => name === "testSuites:resolveOrCreateFileOwnedSuite",
  );
  expect(call).toBeDefined();
  return (call![1] as { judge?: unknown }).judge;
}

describe("POST /eval-suites/from-file sends the judge in catalog spelling", () => {
  const originalEnv = {
    CONVEX_URL: process.env.CONVEX_URL,
    CONVEX_HTTP_URL: process.env.CONVEX_HTTP_URL,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_URL = "https://convex.example.com";
    process.env.CONVEX_HTTP_URL = "https://convex-http.example.com";
    validateGuestTokenMock.mockResolvedValue({ valid: false });
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    convexMutationMock.mockResolvedValue({
      created: true,
      suite: { _id: SUITE_ID },
    });
    convexQueryMock.mockImplementation((name: string) =>
      Promise.resolve(
        name === "testSuites:getTestSuite"
          ? { _id: SUITE_ID, projectId: PROJECT_ID, name: "Checkout" }
          : null,
      ),
    );
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.restoreAllMocks();
  });

  it("rewrites an mcpjam/ judge and answers 201", async () => {
    const res = await syncSuite({
      enabled: true,
      model: "mcpjam/anthropic/claude-haiku-4.5",
    });

    expect(res.status).toBe(201);
    expect(judgeSent()).toEqual({
      enabled: true,
      model: "anthropic/claude-haiku-4.5",
    });
  });

  it("forwards a judge without a model exactly", async () => {
    const res = await syncSuite({ enabled: false });

    expect(res.status).toBe(201);
    expect(judgeSent()).toEqual({ enabled: false });
  });

  it("forwards judge: null, which the CLI sends for a file with no judge", async () => {
    const res = await syncSuite(null);

    expect(res.status).toBe(201);
    expect(judgeSent()).toBeNull();
  });
});
