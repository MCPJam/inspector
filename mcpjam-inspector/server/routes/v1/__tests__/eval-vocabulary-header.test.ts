import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * The `x-mcpjam-eval-vocabulary` header on the eval routes — the plumbing
 * only. No field is renamed here: this pins that the header is READ (a bad
 * value is a uniform 400 across the eval surface), that a well-formed value
 * changes nothing yet (vocabulary 2 answers byte-for-byte as vocabulary 1
 * until a later step adds the projections), and that routes outside the eval
 * surface ignore it entirely.
 */

const { validateGuestTokenMock, convexQueryMock, convexMutationMock } =
  vi.hoisted(() => ({
    validateGuestTokenMock: vi.fn(),
    convexQueryMock: vi.fn(),
    convexMutationMock: vi.fn(),
  }));

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenMock,
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn().mockImplementation(() => ({
    setAuth: vi.fn(),
    query: convexQueryMock,
    mutation: convexMutationMock,
    action: vi.fn(),
  })),
}));

import v1Routes from "../index.js";
import { EVAL_VOCABULARY_HEADER } from "../../../utils/eval-vocabulary.js";

function request(
  method: string,
  path: string,
  options: { body?: Record<string, unknown>; vocabulary?: string } = {},
): Promise<Response> {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return Promise.resolve(
    app.request(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer tok",
        ...(options.vocabulary !== undefined
          ? { [EVAL_VOCABULARY_HEADER]: options.vocabulary }
          : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    }),
  );
}

const SUITE = {
  _id: "suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
  projectId: "p1",
  name: "Suite",
  minIterations: 3,
};

const CASE_DOC = {
  _id: "case1xxxxxxxxxxxxxxxxxxxxxxxxxxx",
  testSuiteId: SUITE._id,
  projectId: "p1",
  caseKey: "ui_abc",
  title: "Lists tools",
  query: "What tools?",
  runs: 1,
  models: [{ model: "anthropic/claude-haiku-4.5", provider: "anthropic" }],
  caseType: "prompt",
};

const CASE_PATH = `/api/v1/projects/p1/eval-suites/${SUITE._id}/cases/${CASE_DOC._id}`;

describe("x-mcpjam-eval-vocabulary on the eval routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_URL = "https://convex.example.com";
    process.env.CONVEX_HTTP_URL = "https://convex-http.example.com";
    validateGuestTokenMock.mockResolvedValue({ valid: false });
    convexQueryMock.mockImplementation((name: string) => {
      if (name === "testSuites:getTestSuite") return Promise.resolve(SUITE);
      if (name === "testSuites:getTestCase") return Promise.resolve(CASE_DOC);
      if (name === "projects:getProjectCapabilities") {
        return Promise.resolve({
          projectId: "p1",
          organizationId: "org_1",
          role: "member",
          projectRole: "member",
          isProjectAdmin: false,
          plan: null,
        });
      }
      return Promise.resolve(null);
    });
  });

  it("refuses a value that is neither 1 nor 2 with a 400, before any read", async () => {
    const res = await request("GET", CASE_PATH, { vocabulary: "3" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string; message?: string };
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.message).toContain(EVAL_VOCABULARY_HEADER);
    // The refusal came from the boundary, not from a handler that reached
    // the platform first.
    expect(convexQueryMock).not.toHaveBeenCalledWith(
      "testSuites:getTestCase",
      expect.anything(),
    );
  });

  it("answers vocabulary 2 exactly as vocabulary 1 while nothing varies yet", async () => {
    const one = await request("GET", CASE_PATH);
    const two = await request("GET", CASE_PATH, { vocabulary: "2" });
    expect(one.status).toBe(200);
    expect(two.status).toBe(200);
    expect(await two.text()).toBe(await one.text());
  });

  it("accepts an explicit 1 and a blank value as the default", async () => {
    for (const vocabulary of ["1", " ", ""]) {
      const res = await request("GET", CASE_PATH, { vocabulary });
      expect(res.status, JSON.stringify(vocabulary)).toBe(200);
    }
  });

  it("is ignored by routes outside the eval surface", async () => {
    const res = await request("GET", "/api/v1/projects/p1/capabilities", {
      vocabulary: "3",
    });
    expect(res.status).toBe(200);
  });
});
