import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODE_EVALUATOR_TEST_TIMEOUT_MS,
  codeEvaluatorTestRequestSchema,
  type CodeEvaluatorTestResult,
} from "../../src/contract/index.js";
import {
  OPERATION_FEATURES,
  PlatformApiClient,
  PlatformApiError,
  testEvalCodeEvaluatorOperation,
} from "../../src/platform/index.js";

// "Test on a past iteration" for a code evaluator (EFTW-90, I5).

const PROJECT = {
  id: "project-1",
  name: "Acme",
  description: null,
  icon: null,
  organizationId: "org-a",
  visibility: null,
  createdAt: 1,
  updatedAt: 2,
};
const SUITE = {
  id: "suite-1",
  name: "Invoices",
  projectId: PROJECT.id,
  createdAt: 1,
  updatedAt: 2,
  latestRun: null,
};
const TEST_PATH =
  "/api/v1/projects/project-1/eval-suites/suite-1/code-evaluators/test";
const RESULT: CodeEvaluatorTestResult = {
  runId: "run-1",
  iterationId: "it-1",
  input: "transcript",
  network: "none",
  result: {
    status: "scored",
    score: 0.5,
    threshold: 1,
    passed: false,
    reason: "1 of 2 add up",
  },
  logs: { output: "checked 2\n", exitCode: 0, durationMs: 40 },
};
const TEST = {
  projectId: "project-1",
  suiteId: "suite-1",
  iterationId: "it-1",
  evaluator: { fileName: "check.py", script: "print(1)" },
};

/**
 * A client that answers the project and suite listings, and whose test route
 * never answers, so only its deadline ends a test.
 */
function hangingClient(timeoutMs?: number) {
  const signals: AbortSignal[] = [];
  const fetchMock = vi.fn((input: unknown, init?: RequestInit) => {
    const { pathname } = new URL(String(input));
    if (pathname.endsWith("/projects")) {
      return Promise.resolve(Response.json({ items: [PROJECT] }));
    }
    if (pathname.endsWith("/eval-suites")) {
      return Promise.resolve(Response.json({ items: [SUITE] }));
    }
    const signal = init?.signal;
    if (signal) signals.push(signal);
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason));
    });
  });
  const client = new PlatformApiClient({
    baseUrl: "https://app.test/api/v1",
    getAuth: () => "token",
    fetch: fetchMock as typeof fetch,
    ...(timeoutMs ? { timeoutMs } : {}),
  });
  return { client, signals };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("testEvalCodeEvaluator", () => {
  it("posts only the draft's own fields to the suite's test route", async () => {
    const bodies: unknown[] = [];
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      expect(new URL(String(input)).pathname).toBe(TEST_PATH);
      expect(init?.method).toBe("POST");
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json(RESULT);
    });
    const client = new PlatformApiClient({
      baseUrl: "https://app.test/api/v1",
      getAuth: () => "token",
      fetch: fetchMock as typeof fetch,
    });
    const result = await client.testEvalCodeEvaluator({
      ...TEST,
      evaluator: { ...TEST.evaluator, threshold: 0.5 },
      network: "web",
    });
    expect(result).toEqual(RESULT);
    expect(bodies).toEqual([
      {
        iterationId: "it-1",
        evaluator: { fileName: "check.py", script: "print(1)", threshold: 0.5 },
        network: "web",
      },
    ]);
  });

  it("gives a test five minutes on a client with the usual 30-second deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { client, signals } = hangingClient();
    const settled = client.testEvalCodeEvaluator(TEST).then(
      () => undefined,
      (error: unknown) => error
    );
    await vi.advanceTimersByTimeAsync(30_001);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(CODE_EVALUATOR_TEST_TIMEOUT_MS - 30_001);
    const error = await settled;
    expect(error).toBeInstanceOf(PlatformApiError);
    expect((error as PlatformApiError).message).toBe(
      `Request to ${TEST_PATH.replace("/api/v1", "")} timed out after ${CODE_EVALUATOR_TEST_TIMEOUT_MS}ms`
    );
  });

  it("keeps a client's own longer deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { client, signals } = hangingClient(600_000);
    const settled = client.testEvalCodeEvaluator(TEST).then(
      () => undefined,
      (error: unknown) => error
    );
    await vi.advanceTimersByTimeAsync(CODE_EVALUATOR_TEST_TIMEOUT_MS + 1);
    expect(signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(await settled).toBeInstanceOf(PlatformApiError);
  });

  it("checks a draft with a saved evaluator's limits", () => {
    const parse = (evaluator: Record<string, unknown>) =>
      codeEvaluatorTestRequestSchema.safeParse({ iterationId: "i", evaluator })
        .success;
    expect(parse({ fileName: "check.py", script: "x" })).toBe(true);
    expect(parse({ fileName: "check.rb", script: "x" })).toBe(false);
    expect(parse({ fileName: "check.py", script: "" })).toBe(false);
    expect(parse({ fileName: "check.py", script: "x", threshold: 0 })).toBe(
      false
    );
    expect(parse({ fileName: "check.py", script: "x", id: "a b" })).toBe(false);
    expect(parse({ fileName: "check.py", script: "x", role: "required" })).toBe(
      false
    );
    expect(parse({ fileName: "check.py", script: "é".repeat(40_000) })).toBe(
      false
    );
  });
});

/** A client whose API answers the project, suite and test routes. */
function clientWith() {
  const bodies: unknown[] = [];
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/projects")) {
      return Response.json({ items: [PROJECT] });
    }
    if (url.pathname.endsWith("/eval-suites")) {
      return Response.json({ items: [SUITE] });
    }
    if (init?.method === "POST" && url.pathname === TEST_PATH) {
      bodies.push(JSON.parse(String(init.body)));
      return Response.json(RESULT);
    }
    return Response.json({ code: "NOT_FOUND", message: "no" }, { status: 404 });
  });
  const client = new PlatformApiClient({
    baseUrl: "https://app.test/api/v1",
    getAuth: () => "token",
    fetch: fetchMock as typeof fetch,
  });
  return { client, bodies };
}

describe("test_eval_code_evaluator", () => {
  it("finds the suite by name and returns the test with where it ran", async () => {
    const { client, bodies } = clientWith();
    const scopes: unknown[] = [];
    const result = await testEvalCodeEvaluatorOperation.execute(
      {
        suite: "invoices",
        iterationId: "it-1",
        evaluator: { fileName: "check.py", script: "print(1)", id: "totals" },
      },
      { client, onScopeResolved: (scope) => scopes.push(scope) }
    );
    expect(bodies).toEqual([
      {
        iterationId: "it-1",
        evaluator: { fileName: "check.py", script: "print(1)", id: "totals" },
      },
    ]);
    expect(result).toEqual({
      ...RESULT,
      project: { id: PROJECT.id, name: "Acme", organizationId: "org-a" },
      suite: { id: SUITE.id, name: "Invoices" },
    });
    expect(scopes).toEqual([
      { projectId: PROJECT.id, organizationId: "org-a" },
    ]);
    const policy = testEvalCodeEvaluatorOperation.permalink;
    expect(
      policy.kind === "derive" &&
        policy.resources(
          result,
          {
            suite: "invoices",
            iterationId: "it-1",
            evaluator: { fileName: "a.sh", script: "x" },
          },
          { appOrigin: "https://app.test" }
        )
    ).toEqual([
      {
        type: "eval_iteration",
        id: "it-1",
        parent: {
          type: "eval_run",
          id: "run-1",
          parent: { type: "eval_suite", id: SUITE.id },
        },
        projectId: PROJECT.id,
      },
    ]);
  });

  // The hosted MCP server and the in-app agent run operations on clients
  // with the 30-second default, so this is the deadline their tests get.
  it("gets five minutes on a client with the usual 30-second deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { client, signals } = hangingClient();
    const settled = testEvalCodeEvaluatorOperation
      .execute(
        {
          suite: "Invoices",
          iterationId: "it-1",
          evaluator: { fileName: "check.py", script: "print(1)" },
        },
        { client }
      )
      .then(
        () => undefined,
        (error: unknown) => error
      );
    await vi.advanceTimersByTimeAsync(30_001);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(CODE_EVALUATOR_TEST_TIMEOUT_MS - 30_001);
    expect(await settled).toBeInstanceOf(PlatformApiError);
  });

  it("refuses an unknown key on the operation's input too", () => {
    expect(
      testEvalCodeEvaluatorOperation.inputSchema.safeParse({
        suite: "s",
        iterationId: "i",
        evaluator: { fileName: "check.py", script: "x" },
        extra: true,
      }).success
    ).toBe(false);
  });

  it("is a write that spends, released to every organization the backend admits", () => {
    expect(testEvalCodeEvaluatorOperation.readOnly).toBe(false);
    expect(testEvalCodeEvaluatorOperation.risk).toBe("spend");
    expect(OPERATION_FEATURES.test_eval_code_evaluator).toBeNull();
    const { description } = testEvalCodeEvaluatorOperation;
    expect(description).toMatch(/unsaved draft/);
    expect(description).toMatch(/Writes nothing/);
    expect(description).toMatch(/finished/);
    expect(description).toMatch(/paid sandbox/);
  });
});
