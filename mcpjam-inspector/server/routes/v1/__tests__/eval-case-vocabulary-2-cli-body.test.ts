import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * The case bodies the CLI sends under `x-mcpjam-eval-vocabulary: 2` are the
 * bodies this route accepts.
 *
 * The CLI's `eval run --file` writes cases through `createEvalCases` (batch)
 * and `updateEvalCase`, and once a deployment advertises vocabulary 2 it
 * spells them canonically: `iterations` + `legacyIterations` for the file's
 * one configured count, `assertions` for the rules. Under vocabulary 2 the
 * OLD body — `iterations` + `repetitions` + `checks` — is the both-spellings
 * refusal `eval-case-vocabulary-2.test.ts` pins, so this file is the other
 * half of that pin: the NEW body lands.
 *
 * The bodies below are spelled out rather than imported from the CLI: the
 * server suite does not resolve the CLI's module graph, so the CLI's own
 * tests pin that `fileCaseToCreateBody` / `fileCaseToUpdateBody` produce
 * exactly these keys (`cli/tests/eval-suite-file.test.ts`, "file-owned case
 * bodies"). The two pins meet in the middle; change one, change both.
 *
 * Harness and fixtures follow `eval-case-vocabulary-2.test.ts`.
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
import { EVAL_VOCABULARY_HEADER } from "../eval-vocabulary.js";

function request(
  method: string,
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return Promise.resolve(
    app.request(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer tok",
        [EVAL_VOCABULARY_HEADER]: "2",
      },
      body: JSON.stringify(body),
    }),
  );
}

const SUITE_ID = "suite1xxxxxxxxxxxxxxxxxxxxxxxxxx";
const CASE_ID = "case1xxxxxxxxxxxxxxxxxxxxxxxxxxx";
const DECLARED_SUITE_ID = "s_billing";

const V2_SUITE = {
  _id: SUITE_ID,
  projectId: "p1",
  name: "Suite",
  declaredId: DECLARED_SUITE_ID,
  minIterations: 3,
  verdictPolicyVersion: 2,
  verdictPolicyDefaults: { repetitions: 5, passThreshold: 0.8 },
};

const CASE_DOC = {
  _id: CASE_ID,
  testSuiteId: SUITE_ID,
  projectId: "p1",
  caseKey: "c_refund_duplicate",
  title: "Refunds a duplicate charge",
  query: "Refund the duplicate charge on invoice 4471.",
  runs: 4,
  repetitions: 2,
  models: [{ model: "anthropic/claude-sonnet-4-6", provider: "anthropic" }],
  caseType: "prompt",
};

const RULES = [{ type: "toolCalledAtLeastOnce", toolName: "search" }];

/** `fileCaseToCreateBody(testCase, 2)` for the minimal suite-file case. */
const CLI_CREATE_BODY_V2 = {
  id: "c_refund_duplicate",
  title: "Refunds a duplicate charge",
  steps: [
    {
      id: "step-1",
      kind: "prompt",
      prompt: "Refund the duplicate charge on invoice 4471.",
    },
  ],
  legacyIterations: 5,
  iterations: 5,
  assertions: { mode: "replace", list: RULES },
  passThreshold: 0.8,
  models: [{ model: "anthropic/claude-sonnet-4-6" }],
};

/** `fileCaseToUpdateBody(testCase, undefined, 2)` for a case that dropped its rules. */
const CLI_UPDATE_BODY_V2 = {
  title: "Refunds a duplicate charge",
  intent: null,
  kind: null,
  steps: CLI_CREATE_BODY_V2.steps,
  legacyIterations: 5,
  iterations: 5,
  assertions: null,
  passThreshold: 0.8,
  expectedOutput: "",
  isNegative: false,
  models: [{ model: "anthropic/claude-sonnet-4-6" }],
  import: null,
};

const SUITE_PATH = `/api/v1/projects/p1/eval-suites/${SUITE_ID}`;

function authoredCase(index = 0): any {
  const call = convexMutationMock.mock.calls.find(
    (c) => c[0] === "testSuites:createTestCases",
  );
  return call?.[1]?.cases?.[index];
}

function patchedCase(): any {
  const calls = convexMutationMock.mock.calls.filter(
    (c) => c[0] === "testSuites:updateTestCase",
  );
  return calls[calls.length - 1]?.[1];
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CONVEX_URL = "https://convex.example.com";
  process.env.CONVEX_HTTP_URL = "https://convex-http.example.com";
  validateGuestTokenMock.mockResolvedValue({ valid: false });
  convexQueryMock.mockImplementation((name: string) => {
    if (name === "testSuites:getTestSuite") return Promise.resolve(V2_SUITE);
    if (name === "testSuites:getTestCase") return Promise.resolve(CASE_DOC);
    if (name === "testSuites:listTestCases") return Promise.resolve([CASE_DOC]);
    return Promise.resolve(null);
  });
  convexMutationMock.mockImplementation((name: string, args?: any) => {
    if (name === "testSuites:createTestCases") {
      return Promise.resolve({
        caseUpsert: {
          committed: (args?.cases ?? []).map((item: any, index: number) => ({
            index,
            title: String(item.title ?? ""),
            testCaseId: CASE_ID,
            replayed: false,
          })),
          failed: [],
        },
        duplicatePolicy: { effectivePolicy: "block", coerced: false },
        warnings: [],
      });
    }
    if (name === "testSuites:updateTestCase") return Promise.resolve(CASE_DOC);
    return Promise.resolve(null);
  });
});

describe("vocabulary 2 — the CLI's file-sync bodies land", () => {
  it("batch-creates the canonical body: one count under both names, rules as `assertions`", async () => {
    const res = await request(
      "POST",
      `${SUITE_PATH}/cases/batch?declaredSuiteId=${DECLARED_SUITE_ID}`,
      { cases: [CLI_CREATE_BODY_V2], declaredSuiteId: DECLARED_SUITE_ID },
    );
    expect(res.status, await res.text()).toBe(201);
    const stored = authoredCase();
    // The file's ONE configured count reaches storage as both the exact
    // count and the legacy floor, exactly as the vocabulary-1 body did.
    expect(stored.repetitions).toBe(5);
    expect(stored.runs).toBe(5);
    expect(stored.predicates).toEqual({ mode: "replace", list: RULES });
    // No canonical key is forwarded to the platform.
    expect("iterations" in stored).toBe(false);
    expect("legacyIterations" in stored).toBe(false);
    expect("assertions" in stored).toBe(false);
  });

  it("patches the canonical body, and `assertions: null` clears the stored rules", async () => {
    const res = await request(
      "PATCH",
      `${SUITE_PATH}/cases/${CASE_ID}?declaredSuiteId=${DECLARED_SUITE_ID}`,
      { ...CLI_UPDATE_BODY_V2, declaredSuiteId: DECLARED_SUITE_ID },
    );
    expect(res.status, await res.text()).toBe(200);
    const stored = patchedCase();
    expect(stored.repetitions).toBe(5);
    expect(stored.runs).toBe(5);
    expect(stored.predicates).toBeNull();
  });

  it("still refuses the vocabulary-1 body under the header — the hazard the CLI's gate exists for", async () => {
    const res = await request(
      "POST",
      `${SUITE_PATH}/cases/batch?declaredSuiteId=${DECLARED_SUITE_ID}`,
      {
        cases: [
          {
            ...CLI_CREATE_BODY_V2,
            legacyIterations: undefined,
            assertions: undefined,
            iterations: 5,
            repetitions: 5,
            checks: { mode: "replace", list: RULES },
          },
        ],
        declaredSuiteId: DECLARED_SUITE_ID,
      },
    );
    expect(res.status).toBe(400);
    expect(convexMutationMock).not.toHaveBeenCalled();
  });
});
