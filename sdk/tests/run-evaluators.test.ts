import {
  argumentConsistency,
  buildRunEvaluatorContext,
  evaluateCaseRun,
  selectionStability,
} from "../src/run-evaluators";
import type { RunIterationEvidence, RunEvaluator } from "../src/run-evaluators";

const iteration = (
  index: number,
  toolName?: string,
  args: unknown = {}
): RunIterationEvidence => ({
  iterationId: `i${index}`,
  status: "completed",
  capture: "complete",
  toolCalls: toolName ? [{ toolName, arguments: args }] : [],
  provider: "provider",
  model: "model",
  hostConfigHash: "host",
});
const context = (iterations: RunIterationEvidence[]) =>
  buildRunEvaluatorContext({
    caseId: "case",
    sourceConfigHash: "config",
    iterations,
  });

describe("advisory case-run evaluators", () => {
  it("measures 4/5 first-tool modal agreement without claiming correctness", async () => {
    const run = await evaluateCaseRun(
      [selectionStability()],
      context([
        iteration(0, "wrong"),
        iteration(1, "wrong"),
        iteration(2, "wrong"),
        iteration(3, "wrong"),
        iteration(4, "different"),
      ])
    );
    expect(run.results[0]).toMatchObject({
      status: "scored",
      score: 0.8,
      passed: true,
    });
    expect(run.observations[0]).toMatchObject({
      eligibleIterations: 5,
      excludedIterations: 0,
      categories: [
        { value: "tool:wrong", count: 4 },
        { value: "tool:different", count: 1 },
      ],
    });
    expect(run.results[0].explanation).toContain("not correctness");
    expect(
      run.evaluationConfig.definitions.every((row) => row.role === "advisory")
    ).toBe(true);
    expect(run.scope).toBe("case_run");
  });

  it("distinguishes observed no-tool choices from uncaptured and failed iterations", async () => {
    const run = await evaluateCaseRun(
      [selectionStability()],
      context([
        iteration(0),
        iteration(1),
        { ...iteration(2), capture: "unknown" },
        { ...iteration(3), status: "failed" },
      ])
    );
    expect(run.results[0].score).toBe(1);
    expect(run.observations[0]).toMatchObject({
      eligibleIterations: 2,
      excludedIterations: 2,
      categories: [{ value: "no_tool", count: 2 }],
    });
    expect(run.observations[0].exclusions.map((value) => value.reason)).toEqual(
      ["capture_unknown", "execution_incomplete"]
    );
  });

  it("compares only the first named-tool arguments, ignores key order, and hides raw values", async () => {
    const rows = [
      iteration(0, "target", { b: 2, a: "canary-secret" }),
      iteration(1, "target", { a: "canary-secret", b: 2 }),
      iteration(2, "other"),
    ];
    rows[0].toolCalls.push({
      toolName: "target",
      arguments: { different: true },
    });
    const run = await evaluateCaseRun(
      [argumentConsistency("target")],
      context(rows)
    );
    expect(run.results[0].score).toBe(1);
    expect(run.observations[0]).toMatchObject({
      eligibleIterations: 2,
      excludedIterations: 1,
    });
    expect(JSON.stringify(run)).not.toContain("canary-secret");
    const absent = await evaluateCaseRun(
      [argumentConsistency("target")],
      context([iteration(0), iteration(1)])
    );
    expect(absent.results[0].status).toBe("skipped");
    expect(absent.results[0].score).toBeUndefined();
  });

  it("refuses mixed cases, model/host provenance and unknown mixed with known", () => {
    expect(() =>
      context([iteration(0), { ...iteration(1), caseId: "other" }])
    ).toThrow(/mix cases/);
    expect(() =>
      context([iteration(0), { ...iteration(1), model: "other" }])
    ).toThrow(/mix model/);
    expect(() =>
      context([iteration(0), { ...iteration(1), hostConfigHash: undefined }])
    ).toThrow(/mix host/);
    expect(() => context([iteration(0), iteration(0)])).toThrow(/unique/);
  });

  it("bounds hanging evaluators and cannot accept late coverage", async () => {
    let finish!: (value: any) => void;
    const evaluator: RunEvaluator = {
      definition: selectionStability().definition,
      timeoutMs: 10,
      evaluate: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    };
    const run = await evaluateCaseRun(
      [evaluator],
      context([iteration(0), iteration(1)])
    );
    expect(run.results[0].status).toBe("error");
    expect(run.observations[0].eligibleIterations).toBe(0);
    finish({
      outcome: { kind: "scored", score: 1 },
      observation: { eligibleIterations: 2, exclusions: [] },
    });
    await Promise.resolve();
    expect(run.observations[0].eligibleIterations).toBe(0);
  });

  it("changes definition identity with coverage parameters, rejects gating and invalid coverage", async () => {
    expect(selectionStability().definition.implementationHash).not.toBe(
      selectionStability({ minEligibleIterations: 3 }).definition
        .implementationHash
    );
    expect(() => selectionStability({ minAgreement: NaN })).toThrow();
    const gating = {
      ...selectionStability(),
      definition: {
        ...selectionStability().definition,
        role: "gating" as const,
      },
    };
    await expect(
      evaluateCaseRun([gating], context([iteration(0)]))
    ).rejects.toThrow(/advisory/);
    const inconsistent: RunEvaluator = {
      ...selectionStability(),
      evaluate: () => ({
        outcome: { kind: "scored", score: 1 },
        observation: { eligibleIterations: 100, exclusions: [] },
      }),
    };
    expect(
      (await evaluateCaseRun([inconsistent], context([iteration(0)])))
        .results[0].status
    ).toBe("error");
  });
});
