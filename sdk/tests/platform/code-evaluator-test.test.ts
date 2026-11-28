import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODE_EVALUATOR_TEST_TIMEOUT_MS,
  codeEvaluatorTestRequestSchema,
  type CodeEvaluatorTestResult,
} from "../../src/contract/index.js";
import {
  PlatformApiClient,
  PlatformApiError,
} from "../../src/platform/index.js";

// "Test on a past iteration" for a code evaluator (EFTW-90, I5).

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

/** A client whose test route never answers, so only its deadline ends it. */
function hangingClient(timeoutMs?: number) {
  const signals: AbortSignal[] = [];
  const fetchMock = vi.fn((_input: unknown, init?: RequestInit) => {
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
