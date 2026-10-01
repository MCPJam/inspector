import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// CONVEX-33X: a suite file named its judge `mcpjam/anthropic/claude-haiku-4.5`,
// the spelling the SDK and CLI document for an MCPJam-hosted model, and the
// backend refused it as "not in MCPJam's hosted model catalog", which knows the
// model as `anthropic/claude-haiku-4.5`. The API now sends the catalog
// spelling on every route that sets a judge model.

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
import { canonicalJudgeModelId } from "../judge-model-id.js";
import { logger } from "../../../utils/logger.js";

const PROJECT_ID = "k57a1b2c3d4e5f6g7h8j9k0m1n2p3q4r";
const RUN_ID = "j57a1b2c3d4e5f6g7h8j9k0m1n2p3q4r";

function makeApp(): Hono {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return app;
}

function post(path: string, body: unknown) {
  return makeApp().request(`/api/v1/projects/${PROJECT_ID}${path}`, {
    method: "POST",
    headers: {
      Authorization: "Bearer tok",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("canonicalJudgeModelId", () => {
  it("drops the hosted prefix the SDK documents", () => {
    expect(canonicalJudgeModelId("mcpjam/anthropic/claude-haiku-4.5")).toBe(
      "anthropic/claude-haiku-4.5",
    );
    expect(canonicalJudgeModelId(" mcpjam/openai/gpt-5.4-mini ")).toBe(
      "openai/gpt-5.4-mini",
    );
  });

  it("leaves catalog ids alone", () => {
    expect(canonicalJudgeModelId("anthropic/claude-haiku-4.5")).toBe(
      "anthropic/claude-haiku-4.5",
    );
  });

  it("passes a malformed hosted id through so the refusal names it", () => {
    expect(canonicalJudgeModelId("mcpjam/claude-haiku-4.5")).toBe(
      "mcpjam/claude-haiku-4.5",
    );
    expect(canonicalJudgeModelId("mcpjam//x")).toBe("mcpjam//x");
  });
});

describe("judge model routes send the catalog spelling", () => {
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
    vi.spyOn(logger, "error").mockImplementation(() => {});
    // Stop each route right after the write under test; only its arguments
    // matter here.
    convexMutationMock.mockRejectedValue(new Error("stop after the write"));
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.restoreAllMocks();
  });

  it("from-file: a suite file's mcpjam/ judge", async () => {
    await post("/eval-suites/from-file", {
      declaredSuiteId: "checkout-suite",
      name: "Checkout",
      sourceHash: "a".repeat(64),
      judge: { enabled: true, model: "mcpjam/anthropic/claude-haiku-4.5" },
    });

    expect(convexMutationMock).toHaveBeenCalledWith(
      "testSuites:resolveOrCreateFileOwnedSuite",
      expect.objectContaining({
        judge: { enabled: true, model: "anthropic/claude-haiku-4.5" },
      }),
    );
  });

  it("from-file: a judge without a model is forwarded unchanged", async () => {
    await post("/eval-suites/from-file", {
      declaredSuiteId: "checkout-suite",
      name: "Checkout",
      sourceHash: "a".repeat(64),
      judge: { enabled: false },
    });

    expect(convexMutationMock).toHaveBeenCalledWith(
      "testSuites:resolveOrCreateFileOwnedSuite",
      expect.objectContaining({ judge: { enabled: false } }),
    );
  });

  it("suite settings: an mcpjam/ judge model", async () => {
    const SUITE_ID = "s57a1b2c3d4e5f6g7h8j9k0m1n2p3q4r";
    convexQueryMock.mockResolvedValue({
      _id: SUITE_ID,
      projectId: PROJECT_ID,
      judgeConfig: { goalCompletion: { enabled: true } },
    });

    await makeApp().request(
      `/api/v1/projects/${PROJECT_ID}/eval-suites/${SUITE_ID}`,
      {
        method: "PATCH",
        headers: {
          Authorization: "Bearer tok",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          settings: { judge: { model: "mcpjam/anthropic/claude-haiku-4.5" } },
        }),
      },
    );

    expect(convexMutationMock).toHaveBeenCalledWith(
      "testSuites:updateTestSuite",
      expect.objectContaining({
        judgeConfig: expect.objectContaining({
          goalCompletion: expect.objectContaining({
            enabled: true,
            judgeModel: "anthropic/claude-haiku-4.5",
          }),
        }),
      }),
    );
  });

  it("run judge: a per-run mcpjam/ model override", async () => {
    convexQueryMock.mockResolvedValue({
      _id: RUN_ID,
      projectId: PROJECT_ID,
    });

    await post(`/eval-runs/${RUN_ID}/judge`, {
      model: "mcpjam/openai/gpt-5.4-mini",
    });

    expect(convexMutationMock).toHaveBeenCalledWith(
      "goalCompletion:requestGoalCompletion",
      expect.objectContaining({
        runOverride: expect.objectContaining({
          judgeModel: "openai/gpt-5.4-mini",
        }),
      }),
    );
  });
});
