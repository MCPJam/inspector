import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// The two INLINE-TEST items on the v1 eval surface — `POST /eval-suites`'s
// `tests[]` and `POST /eval-runs`'s `tests[]` — were bare `z.object`s inside
// strict parents. A bare object strips unknown keys silently, and the keys
// these items do not name are exactly the public case-authoring names a caller
// reads back on a GET (`isNegative`, `iterations`, `checks`).
//
// So a caller who wrote down what the API returned got a 201 with all of it
// dropped. `isNegative` is the one that hurts: it is what makes a case pass
// when a tool is NOT called, so dropping it stored the case with the OPPOSITE
// meaning and no error anywhere.
//
// These tests are written against the CONTRACT — what a caller sends and what
// reaches the authoring seam — not against the schema object, so a future
// rewrite of the schema cannot satisfy them by agreeing with itself.

const {
  validateGuestTokenMock,
  prepareEvalRunMock,
  authorEvalSuiteMock,
  createAuthorizedManagerMock,
  convexQueryMock,
  convexActionMock,
  convexMutationMock,
} = vi.hoisted(() => ({
  validateGuestTokenMock: vi.fn(),
  prepareEvalRunMock: vi.fn(),
  authorEvalSuiteMock: vi.fn(),
  createAuthorizedManagerMock: vi.fn(),
  convexQueryMock: vi.fn(),
  convexActionMock: vi.fn(),
  convexMutationMock: vi.fn(),
}));

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenMock,
}));

vi.mock("../../shared/evals.js", async () => {
  const actual = await vi.importActual<typeof import("../../shared/evals.js")>(
    "../../shared/evals.js"
  );
  return {
    ...actual,
    prepareEvalRun: prepareEvalRunMock,
    authorEvalSuite: authorEvalSuiteMock,
  };
});

vi.mock("../../web/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../web/auth.js")>(
    "../../web/auth.js"
  );
  return { ...actual, createAuthorizedManager: createAuthorizedManagerMock };
});

vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn().mockImplementation(() => ({
    setAuth: vi.fn(),
    query: convexQueryMock,
    action: convexActionMock,
    mutation: convexMutationMock,
  })),
}));

import v1Routes from "../index.js";

function request(
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<Response> {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return Promise.resolve(
    app.request(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer tok",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  );
}

const STEPS = [
  { id: "s1", kind: "prompt", prompt: "Do not call any tool" },
  {
    id: "s2",
    kind: "assert",
    assertion: { type: "toolCalledWith", toolName: "echo", args: { args: {} } },
  },
];

const MODEL = "anthropic/claude-haiku-4.5";

function suiteBody(test: Record<string, unknown>) {
  return {
    name: "Fresh suite",
    serverIds: ["s1"],
    model: MODEL,
    tests: [{ title: "does not call echo", steps: STEPS, ...test }],
  };
}

function runBody(test: Record<string, unknown>) {
  return {
    suiteName: "Fresh suite",
    serverIds: ["s1"],
    tests: [
      {
        title: "does not call echo",
        steps: STEPS,
        model: MODEL,
        provider: "anthropic",
        ...test,
      },
    ],
  };
}

async function errorBody(res: Response) {
  return (await res.json()) as { code?: string; message?: string };
}

describe("v1 inline-test vocabulary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_URL = "https://convex.example.com";
    process.env.CONVEX_HTTP_URL = "https://convex-http.example.com";
    validateGuestTokenMock.mockResolvedValue({ valid: false });
    convexQueryMock.mockImplementation(async (fn: string) =>
      fn === "testSuites:getTestSuite"
        ? { _id: "suite_1", projectId: "p1", name: "Smoke" }
        : null
    );
    createAuthorizedManagerMock.mockResolvedValue({
      manager: {
        listServers: () => ["s1"],
        disconnectAllServers: vi.fn().mockResolvedValue(undefined),
      },
      oauthServerUrls: {},
      authenticatedUserId: null,
    });
    authorEvalSuiteMock.mockResolvedValue({
      suiteId: "suite_new",
      suiteName: "Fresh suite",
      caseUpsert: { committed: [{ name: "does not call echo" }], failed: [] },
    });
    prepareEvalRunMock.mockResolvedValue({
      suiteId: "suite_new",
      runId: "run_1",
      caseUpsert: { committed: [], failed: [] },
      recorder: { finalize: vi.fn() },
      execute: vi.fn().mockResolvedValue(undefined),
    });
  });

  describe("POST /eval-suites — the negative-test inversion", () => {
    // THE bug. A 201 that stored the opposite of what was sent: a case that
    // must pass when the tool is NOT called, persisted as an ordinary positive
    // case, with nothing anywhere saying so.
    it("stores a case sent as `isNegative` as a negative case", async () => {
      const res = await request(
        "POST",
        "/api/v1/projects/p1/eval-suites",
        suiteBody({ isNegative: true })
      );

      expect(res.status).toBe(201);
      expect(authorEvalSuiteMock).toHaveBeenCalledTimes(1);
      expect(authorEvalSuiteMock.mock.calls[0][0].tests[0]).toMatchObject({
        isNegativeTest: true,
      });
    });

    it("keeps the legacy `isNegativeTest` spelling working", async () => {
      const res = await request(
        "POST",
        "/api/v1/projects/p1/eval-suites",
        suiteBody({ isNegativeTest: true })
      );

      expect(res.status).toBe(201);
      expect(authorEvalSuiteMock.mock.calls[0][0].tests[0]).toMatchObject({
        isNegativeTest: true,
      });
    });

    it("stores `iterations` as the case's trial count", async () => {
      const res = await request(
        "POST",
        "/api/v1/projects/p1/eval-suites",
        suiteBody({ iterations: 5 })
      );

      expect(res.status).toBe(201);
      expect(authorEvalSuiteMock.mock.calls[0][0].tests[0].runs).toBe(5);
    });

    it("stores `checks` as the case's predicate gate", async () => {
      const checks = {
        mode: "replace",
        list: [{ type: "responseContains", needle: "hi" }],
      };
      const res = await request(
        "POST",
        "/api/v1/projects/p1/eval-suites",
        suiteBody({ checks })
      );

      expect(res.status).toBe(201);
      expect(authorEvalSuiteMock.mock.calls[0][0].tests[0].predicates).toEqual(
        checks
      );
    });
  });

  describe("POST /eval-runs — the same item, the same inversion", () => {
    it("stores an inline case sent as `isNegative` as a negative case", async () => {
      const res = await request(
        "POST",
        "/api/v1/projects/p1/eval-runs",
        runBody({ runs: 1, isNegative: true })
      );

      expect(res.status).toBe(202);
      expect(prepareEvalRunMock).toHaveBeenCalledTimes(1);
      expect(prepareEvalRunMock.mock.calls[0][1].tests[0]).toMatchObject({
        isNegativeTest: true,
      });
    });

    it("accepts `iterations` in place of the required `runs`", async () => {
      const res = await request(
        "POST",
        "/api/v1/projects/p1/eval-runs",
        runBody({ iterations: 3 })
      );

      expect(res.status).toBe(202);
      expect(prepareEvalRunMock.mock.calls[0][1].tests[0].runs).toBe(3);
    });

    it("still requires one of the two spellings — a run has no suite default", async () => {
      const res = await request(
        "POST",
        "/api/v1/projects/p1/eval-runs",
        runBody({})
      );

      expect(res.status).toBe(400);
      expect((await errorBody(res)).code).toBe("VALIDATION_ERROR");
      expect(prepareEvalRunMock).not.toHaveBeenCalled();
    });
  });

  describe("ambiguous and unauthorable bodies are refused, not resolved", () => {
    it("refuses both spellings of one field rather than picking one", async () => {
      const res = await request(
        "POST",
        "/api/v1/projects/p1/eval-suites",
        suiteBody({ isNegative: true, isNegativeTest: false })
      );

      expect(res.status).toBe(400);
      expect((await errorBody(res)).message).toMatch(/not both/);
      expect(authorEvalSuiteMock).not.toHaveBeenCalled();
    });

    it.each(["passThreshold", "kind", "repetitions"] as const)(
      "refuses %s here and names the route that persists it",
      async (field) => {
        const value = field === "kind" ? "regression" : 0.8;
        const res = await request(
          "POST",
          "/api/v1/projects/p1/eval-suites",
          suiteBody({ [field]: value })
        );

        expect(res.status).toBe(400);
        const body = await errorBody(res);
        expect(body.code).toBe("VALIDATION_ERROR");
        expect(body.message).toContain(field);
        expect(body.message).toContain("/cases");
        expect(authorEvalSuiteMock).not.toHaveBeenCalled();
      }
    );
  });

  /**
   * The regression guard for the whole class of defect.
   *
   * Every surface that accepts a case body must REJECT a key it does not know
   * rather than drop it. Enumerated explicitly, one entry per surface, so
   * adding a sixth case-authoring route is a visible edit here rather than a
   * silent gap — a name-pattern match over the schemas would have "passed" on
   * day one by finding nothing.
   */
  describe("no case-authoring surface silently drops an unknown key", () => {
    const CASE_BODY = { title: "t", steps: STEPS };
    const SURFACES: Array<{
      name: string;
      method: string;
      path: string;
      body: (unknown_: Record<string, unknown>) => Record<string, unknown>;
    }> = [
      {
        name: "POST /eval-suites tests[]",
        method: "POST",
        path: "/api/v1/projects/p1/eval-suites",
        body: (extra) => suiteBody(extra),
      },
      {
        name: "POST /eval-runs tests[]",
        method: "POST",
        path: "/api/v1/projects/p1/eval-runs",
        body: (extra) => runBody({ runs: 1, ...extra }),
      },
      {
        name: "POST …/cases",
        method: "POST",
        path: "/api/v1/projects/p1/eval-suites/suite_1/cases",
        body: (extra) => ({ ...CASE_BODY, ...extra }),
      },
      {
        name: "POST …/cases/batch",
        method: "POST",
        path: "/api/v1/projects/p1/eval-suites/suite_1/cases/batch",
        body: (extra) => ({ cases: [{ ...CASE_BODY, ...extra }] }),
      },
      {
        name: "PATCH …/cases/:caseId",
        method: "PATCH",
        path: "/api/v1/projects/p1/eval-suites/suite_1/cases/case_1",
        body: (extra) => ({ title: "t", ...extra }),
      },
    ];

    it.each(SURFACES)("$name rejects an unknown key", async (surface) => {
      const res = await request(
        surface.method,
        surface.path,
        surface.body({ notAFieldOnThisContract: true })
      );

      expect(res.status).toBe(400);
      const body = await errorBody(res);
      expect(body.code).toBe("VALIDATION_ERROR");
      expect(body.message).toContain("notAFieldOnThisContract");
      expect(authorEvalSuiteMock).not.toHaveBeenCalled();
      expect(prepareEvalRunMock).not.toHaveBeenCalled();
      expect(convexMutationMock).not.toHaveBeenCalled();
    });
  });
});
