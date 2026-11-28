import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// EFTW-90: `POST /eval-suites/from-file` carries a suite file's code
// evaluators, scripts and grading settings to the backend, `null` included
// (it clears), and refuses what the platform would refuse before the write.

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

function sync(extra: Record<string, unknown>) {
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
      ...extra,
    }),
  });
}

function sent(): Record<string, unknown> | undefined {
  const call = convexMutationMock.mock.calls.find(
    ([name]) => name === "testSuites:resolveOrCreateFileOwnedSuite",
  );
  return call?.[1] as Record<string, unknown> | undefined;
}

const evaluator = {
  id: "totals",
  fileName: "check_totals.py",
  script: "print(1)\n",
  role: "required",
};

describe("POST /eval-suites/from-file with code evaluators", () => {
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

  it("forwards all three fields", async () => {
    const res = await sync({
      codeEvaluators: [evaluator],
      scripts: { iterationSetup: "echo seed" },
      grading: { files: ["/home/user/report.json"] },
    });
    expect(res.status).toBe(201);
    expect(sent()).toMatchObject({
      codeEvaluators: [evaluator],
      scripts: { iterationSetup: "echo seed" },
      grading: { files: ["/home/user/report.json"] },
    });
  });

  it("forwards null, which clears, and sends nothing when the body has none", async () => {
    await sync({ codeEvaluators: null, scripts: null, grading: null });
    expect(sent()).toMatchObject({
      codeEvaluators: null,
      scripts: null,
      grading: null,
    });
    convexMutationMock.mockClear();
    await sync({});
    expect(sent()).not.toHaveProperty("codeEvaluators");
    expect(sent()).not.toHaveProperty("scripts");
    expect(sent()).not.toHaveProperty("grading");
  });

  it("refuses an evaluator the platform would refuse, before the write", async () => {
    const res = await sync({
      codeEvaluators: [{ ...evaluator, fileName: "check.rb" }],
    });
    expect(res.status).toBe(400);
    expect(sent()).toBeUndefined();
  });
});
