import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * The `x-mcpjam-eval-vocabulary` header as the case routes and the
 * capabilities read see it. The reader itself (`eval-vocabulary.ts`) is
 * pinned in `eval-edit.test.ts` ("eval vocabulary negotiation"); this pins
 * what the field-spelling steps build on: that a refusal lands before any
 * platform read, that vocabulary 2 differs from vocabulary 1 in exactly the
 * keys the vocabulary renames and nothing else. (`main`'s reader is mounted
 * on the whole v1 app, so an unknown value is refused everywhere in v1, the
 * capabilities read included.)
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
import {
  EVAL_VOCABULARY_HEADER,
  UNKNOWN_VOCABULARY_MESSAGE,
} from "../eval-vocabulary.js";

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

/** The keys a case DTO renames between vocabulary 1 and 2. */
const RENAMED: Record<string, string> = {
  iterations: "legacyIterations",
  repetitions: "iterations",
  checks: "assertions",
};

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
    expect(body.message).toBe(UNKNOWN_VOCABULARY_MESSAGE);
    // The refusal came from the boundary, not from a handler that reached
    // the platform first.
    expect(convexQueryMock).not.toHaveBeenCalledWith(
      "testSuites:getTestCase",
      expect.anything(),
    );
  });

  it("answers vocabulary 2 as vocabulary 1 with exactly the renamed keys", async () => {
    // The projection is a rename in place, never a reshaping: the two bodies
    // differ in the keys the vocabulary renames and in nothing else.
    const one = await request("GET", CASE_PATH);
    const two = await request("GET", CASE_PATH, { vocabulary: "2" });
    expect(one.status).toBe(200);
    expect(two.status).toBe(200);
    const expected = Object.fromEntries(
      Object.entries((await one.json()) as Record<string, unknown>).map(
        ([key, value]) => [RENAMED[key] ?? key, value],
      ),
    );
    expect(await two.json()).toEqual(expected);
  });
});
