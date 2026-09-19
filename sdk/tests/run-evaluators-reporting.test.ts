const capture = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    receipt: {
      schemaVersion: 1,
      state: "persisted",
      acceptedIterations: 2,
      acknowledgedIterations: 2,
      pendingIterations: 0,
      report: {
        suiteId: "suite",
        runId: "run",
        status: "completed",
        result: "passed",
        summary: { total: 2, passed: 2, failed: 0, passRate: 1 },
      },
    },
  })
);
vi.mock("../src/eval-reporting-receipt.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/eval-reporting-receipt.js")
  >()),
  captureEvalReporting: capture,
}));

import { EvalTest } from "../src/EvalTest";
import { PromptResult } from "../src/PromptResult";
import {
  selectionStability,
  RunEvaluatorContextError,
  buildRunEvaluatorContext,
  unavailableCaseRunEvaluation,
  evaluateCaseRun,
} from "../src/run-evaluators";
import type { HostExecutor } from "../src/HostExecutor";

const prompt = (model: string) =>
  PromptResult.from({
    prompt: "task",
    messages: [],
    text: "answer",
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    latency: { e2eMs: 1, llmMs: 1, mcpMs: 0 },
    provider: "provider",
    model,
  });
function mixedExecutor(): HostExecutor {
  let clones = 0;
  return {
    withOptions: () => ({
      getPromptHistory: () => [prompt(`model-${clones++}`)],
    }),
    getPromptHistory: () => [],
  } as unknown as HostExecutor;
}

describe("advisory provenance refusal preserves reporting", () => {
  beforeEach(() => capture.mockClear());

  it("reports passing iteration evidence and unavailable advisory results for mixed models", async () => {
    const evaluator = selectionStability();
    const evaluate = vi.fn(evaluator.evaluate);
    const test = new EvalTest({
      id: "mixed",
      name: "mixed",
      execute: () => {},
      runEvaluators: [{ ...evaluator, evaluate }],
    });
    const result = await test.run(mixedExecutor(), {
      iterations: 2,
      mcpjam: { apiKey: "test-key", strict: true },
    });
    expect(result.successes).toBe(2);
    expect(result.failures).toBe(0);
    expect(evaluate).not.toHaveBeenCalled();
    expect(result.runEvaluation?.results).toHaveLength(1);
    expect(result.runEvaluation?.results[0]).toMatchObject({ status: "error" });
    expect(result.runEvaluation?.results[0]).not.toHaveProperty("score");
    expect(result.runEvaluation?.observations[0]).toMatchObject({
      eligibleIterations: 0,
      excludedIterations: 2,
      exclusions: [
        { iterationId: "mixed:0", reason: "incompatible_provenance" },
        { iterationId: "mixed:1", reason: "incompatible_provenance" },
      ],
    });
    expect(capture).toHaveBeenCalledTimes(1);
    const reported = capture.mock.calls[0][0];
    expect(
      reported.results.map((value: any) => value.externalIterationId)
    ).toEqual(["mixed:0", "mixed:1"]);
    expect(reported.results.every((value: any) => value.passed)).toBe(true);
    expect(reported.runEvaluations).toEqual([result.runEvaluation]);
    expect(test.getReportingReceipt().state).toBe("persisted");
  });

  it("uses identical advisory definitions for unavailable and comparable populations", async () => {
    const evaluators = [selectionStability()];
    const unavailable = unavailableCaseRunEvaluation(evaluators, {
      caseId: "case",
      sourceConfigHash: "config",
      iterationIds: ["i0", "i1"],
    });
    const comparable = await evaluateCaseRun(
      evaluators,
      buildRunEvaluatorContext({
        caseId: "case",
        sourceConfigHash: "config",
        iterations: [0, 1].map((index) => ({
          iterationId: `i${index}`,
          status: "completed",
          capture: "complete",
          toolCalls: [],
        })),
      })
    );
    expect(unavailable.evaluationConfig).toEqual(comparable.evaluationConfig);
    expect(unavailable.results[0].definitionHash).toBe(
      comparable.results[0].definitionHash
    );
    expect(() =>
      buildRunEvaluatorContext({
        caseId: "case",
        sourceConfigHash: "config",
        iterations: [
          {
            iterationId: "i0",
            status: "completed",
            capture: "complete",
            toolCalls: [],
            model: "a",
          },
          {
            iterationId: "i1",
            status: "completed",
            capture: "complete",
            toolCalls: [],
            model: "b",
          },
        ],
      })
    ).toThrow(RunEvaluatorContextError);
    expect(() =>
      buildRunEvaluatorContext({
        caseId: "",
        sourceConfigHash: "config",
        iterations: [],
      })
    ).not.toThrow(RunEvaluatorContextError);
  });
});
