import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// Every v1 body that carries tool-call match options accepts BOTH vocabularies
// (public `any|in-order|exact` / `extraToolCalls` / `arguments`, internal
// `ignore|superset|strict` / `maxExtraToolCalls` / `argumentMatching`) and
// stores the internal one. The case surfaces used to disagree: inline tests
// took only the internal names and the case routes only the public ones, so
// `toolCallOrder: "exact"` worked on a run and failed on a case.

const {
  validateGuestTokenMock,
  prepareEvalRunMock,
  authorEvalSuiteMock,
  createAuthorizedManagerMock,
  convexQueryMock,
  convexMutationMock,
} = vi.hoisted(() => ({
  validateGuestTokenMock: vi.fn(),
  prepareEvalRunMock: vi.fn(),
  authorEvalSuiteMock: vi.fn(),
  createAuthorizedManagerMock: vi.fn(),
  convexQueryMock: vi.fn(),
  convexMutationMock: vi.fn(),
}));

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenMock,
}));

vi.mock("../../shared/evals.js", async () => {
  const actual = await vi.importActual<typeof import("../../shared/evals.js")>(
    "../../shared/evals.js",
  );
  return {
    ...actual,
    prepareEvalRun: prepareEvalRunMock,
    authorEvalSuite: authorEvalSuiteMock,
  };
});

vi.mock("../../web/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../web/auth.js")>(
    "../../web/auth.js",
  );
  return { ...actual, createAuthorizedManager: createAuthorizedManagerMock };
});

vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn().mockImplementation(function () {
    return {
      setAuth: vi.fn(),
      query: convexQueryMock,
      mutation: convexMutationMock,
      action: vi.fn(),
    };
  }),
}));

import v1Routes from "../index.js";
import {
  matchOptionsInputSchema,
  mergeMatchOptions,
  toInternalMatchOptions,
  toPublicMatchOptions,
} from "../eval-match-options.js";

const PROJECT = "proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx";
const SUITE = "suite1xxxxxxxxxxxxxxxxxxxxxxxxxx";
const CASE = "case1xxxxxxxxxxxxxxxxxxxxxxxxxxx";
const SUITE_PATH = `/api/v1/projects/${PROJECT}/eval-suites/${SUITE}`;

const SUITE_DOC = {
  _id: SUITE,
  projectId: PROJECT,
  name: "My Suite",
  defaultMatchOptions: {
    toolCallOrder: "superset",
    maxExtraToolCalls: null,
    argumentMatching: "exact",
  },
  createdAt: 1,
  updatedAt: 2,
};

const CASE_DOC = {
  _id: CASE,
  testSuiteId: SUITE,
  projectId: PROJECT,
  caseKey: "ui_abc",
  title: "Lists tools",
  query: "What tools?",
  runs: 1,
  models: [{ model: "anthropic/claude-haiku-4.5", provider: "anthropic" }],
  expectedToolCalls: [],
  isNegativeTest: false,
  promptTurns: [],
  matchOptions: {
    toolCallOrder: "ignore",
    maxExtraToolCalls: null,
    argumentMatching: "partial",
  },
  caseType: "prompt",
  createdAt: 1,
  updatedAt: 2,
};

const STEPS = [{ id: "s1", kind: "prompt", prompt: "Use the echo tool" }];

function request(
  method: string,
  path: string,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return Promise.resolve(
    app.request(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer tok",
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    }),
  );
}

function mutationArgs(name: string): any {
  const calls = convexMutationMock.mock.calls.filter((c) => c[0] === name);
  return calls[calls.length - 1]?.[1];
}

describe("match option vocabulary", () => {
  it("folds public names to internal and passes internal names through", () => {
    expect(
      toInternalMatchOptions({
        toolCallOrder: "exact",
        extraToolCalls: "unlimited",
        arguments: "ignore",
      }),
    ).toEqual({
      toolCallOrder: "strict",
      maxExtraToolCalls: null,
      argumentMatching: "ignore",
    });
    const internal = { toolCallOrder: "superset" as const, maxExtraToolCalls: 2 };
    expect(toInternalMatchOptions(internal)).toEqual(internal);
    expect(toInternalMatchOptions({})).toEqual({});
  });

  it("refuses one object that mixes the two vocabularies", () => {
    expect(
      matchOptionsInputSchema.safeParse({
        toolCallOrder: "exact",
        maxExtraToolCalls: 0,
      }).success,
    ).toBe(false);
  });

  it("lets the bound a patch names replace whichever spelling was stored", () => {
    expect(
      mergeMatchOptions(
        { toolCallOrder: "ignore", allowExtraToolCalls: true },
        { extraToolCalls: 0 },
      ),
    ).toEqual({ toolCallOrder: "ignore", maxExtraToolCalls: 0 });
    // Without dropping the stored modern field the legacy flag would be
    // shadowed on read, and the patch would be a silent no-op.
    const merged = mergeMatchOptions(
      { toolCallOrder: "ignore", maxExtraToolCalls: null },
      { allowExtraToolCalls: false },
    );
    expect(merged).toEqual({
      toolCallOrder: "ignore",
      allowExtraToolCalls: false,
    });
    expect(toPublicMatchOptions(merged)?.extraToolCalls).toBe(0);
  });
});

describe("v1 routes accept either match-option vocabulary per case", () => {
  const originalEnv = {
    CONVEX_URL: process.env.CONVEX_URL,
    CONVEX_HTTP_URL: process.env.CONVEX_HTTP_URL,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_URL = "https://convex.example.com";
    process.env.CONVEX_HTTP_URL = "https://convex-http.example.com";
    validateGuestTokenMock.mockResolvedValue({ valid: false });
    convexQueryMock.mockImplementation((name: string) => {
      if (name === "testSuites:getTestSuite") return Promise.resolve(SUITE_DOC);
      if (name === "testSuites:getTestCase") return Promise.resolve(CASE_DOC);
      if (name === "testSuites:listTestCases") return Promise.resolve([CASE_DOC]);
      if (name === "hosts:listHosts") return Promise.resolve([]);
      return Promise.resolve(null);
    });
    convexMutationMock.mockImplementation((name: string, args?: any) => {
      if (name === "testSuites:createTestCases")
        return Promise.resolve({
          caseUpsert: {
            committed: (args?.cases ?? []).map((item: any, index: number) => ({
              index,
              title: String(item.title ?? ""),
              testCaseId: `case${index + 1}`.padEnd(32, "x"),
              replayed: false,
            })),
            failed: [],
          },
          duplicatePolicy: { effectivePolicy: "block", coerced: false },
          warnings: [],
        });
      if (name === "testSuites:updateTestCase") return Promise.resolve(CASE_DOC);
      if (name === "testSuites:updateTestSuite") return Promise.resolve(SUITE_DOC);
      return Promise.resolve(null);
    });
    createAuthorizedManagerMock.mockResolvedValue({
      manager: {
        listServers: () => ["s1"],
        disconnectAllServers: vi.fn().mockResolvedValue(undefined),
      },
      oauthServerUrls: {},
      authenticatedUserId: null,
    });
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value) process.env[key] = value;
      else delete process.env[key];
    }
  });

  it.each([
    [{ toolCallOrder: "exact" }, { toolCallOrder: "strict" }],
    [
      { toolCallOrder: "strict", maxExtraToolCalls: 0 },
      { toolCallOrder: "strict", maxExtraToolCalls: 0 },
    ],
  ])("creates a case with %j", async (matchOptions, stored) => {
    const res = await request("POST", `${SUITE_PATH}/cases`, {
      title: "ordered",
      steps: STEPS,
      matchOptions,
    });
    expect(res.status).toBe(201);
    expect(mutationArgs("testSuites:createTestCases").cases[0].matchOptions).toEqual(
      stored,
    );
  });

  it("creates cases in a batch with the public names", async () => {
    const res = await request("POST", `${SUITE_PATH}/cases/batch`, {
      cases: [{ title: "ordered", steps: STEPS, matchOptions: { toolCallOrder: "exact" } }],
    });
    expect(res.status).toBe(201);
    expect(mutationArgs("testSuites:createTestCases").cases[0].matchOptions).toEqual({
      toolCallOrder: "strict",
    });
  });

  it.each([
    [{ toolCallOrder: "exact" }, { toolCallOrder: "strict" }],
    [{ argumentMatching: "exact" }, { argumentMatching: "exact" }],
  ])(
    "updates a case with %j, keeping the fields it does not name",
    async (matchOptions, changed) => {
      const res = await request("PATCH", `${SUITE_PATH}/cases/${CASE}`, {
        matchOptions,
      });
      expect(res.status).toBe(200);
      expect(mutationArgs("testSuites:updateTestCase").matchOptions).toEqual({
        ...CASE_DOC.matchOptions,
        ...changed,
      });
    },
  );

  it("updates a case with the public names under vocabulary 2", async () => {
    const res = await request(
      "PATCH",
      `${SUITE_PATH}/cases/${CASE}`,
      { matchOptions: { toolCallOrder: "exact" } },
      { "x-mcpjam-eval-vocabulary": "2" },
    );
    expect(res.status).toBe(200);
    expect(mutationArgs("testSuites:updateTestCase").matchOptions).toEqual({
      ...CASE_DOC.matchOptions,
      toolCallOrder: "strict",
    });
  });

  it("refuses a case body that mixes the vocabularies, before any write", async () => {
    const res = await request("PATCH", `${SUITE_PATH}/cases/${CASE}`, {
      matchOptions: { toolCallOrder: "exact", maxExtraToolCalls: 0 },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe(
      "VALIDATION_ERROR",
    );
    expect(mutationArgs("testSuites:updateTestCase")).toBeUndefined();
  });

  it("merges internal suite defaults onto the stored ones", async () => {
    const res = await request("PATCH", SUITE_PATH, {
      settings: { matchOptions: { toolCallOrder: "strict" } },
    });
    expect(res.status).toBe(200);
    expect(mutationArgs("testSuites:updateTestSuite").defaultMatchOptions).toEqual({
      ...SUITE_DOC.defaultMatchOptions,
      toolCallOrder: "strict",
    });
  });

  it.each([
    [
      { toolCallOrder: "exact", extraToolCalls: 0, arguments: "exact" },
      { toolCallOrder: "strict", maxExtraToolCalls: 0, argumentMatching: "exact" },
    ],
    [{ toolCallOrder: "superset" }, { toolCallOrder: "superset" }],
  ])("authors a new suite's inline case with %j", async (matchOptions, stored) => {
    authorEvalSuiteMock.mockResolvedValue({
      suiteId: "suitenewxxxxxxxxxxxxxxxxxxxxxxxx",
      suiteName: "Fresh suite",
      caseUpsert: { committed: [{ name: "ordered" }], failed: [] },
    });
    const res = await request("POST", `/api/v1/projects/${PROJECT}/eval-suites`, {
      name: "Fresh suite",
      serverIds: ["s1"],
      model: "anthropic/claude-haiku-4.5",
      tests: [{ title: "ordered", steps: STEPS, matchOptions }],
    });
    expect(res.status).toBe(201);
    expect(authorEvalSuiteMock.mock.calls[0][0].tests[0].matchOptions).toEqual(
      stored,
    );
  });

  it("runs an inline case with the public names", async () => {
    prepareEvalRunMock.mockResolvedValue({
      suiteId: SUITE,
      runId: "run1xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      caseUpsert: { committed: [], failed: [] },
      recorder: { finalize: vi.fn() },
      execute: vi.fn().mockResolvedValue(undefined),
    });
    const res = await request("POST", `/api/v1/projects/${PROJECT}/eval-runs`, {
      suiteName: "smoke",
      serverIds: ["s1"],
      tests: [
        {
          title: "ordered",
          steps: STEPS,
          runs: 1,
          model: "anthropic/claude-haiku-4.5",
          provider: "anthropic",
          matchOptions: { toolCallOrder: "exact" },
        },
      ],
    });
    expect(res.status).toBe(202);
    expect(prepareEvalRunMock.mock.calls[0][1].tests[0].matchOptions).toEqual({
      toolCallOrder: "strict",
    });
  });
});
