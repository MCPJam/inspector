import { describe, expect, it } from "vitest";
import type { Predicate } from "@/shared/eval-matching";
import type { AssertStep, TestStep } from "@/shared/steps";
import type {
  EvalCase,
  EvalIteration,
  EvalSuiteRun,
} from "../../../evals/types";
import { buildCaseScorecard } from "../../case-scorecard/case-scorecard-model";
import { buildExecutionPreview } from "../../case-steps/case-steps-model";
import {
  caseIterations,
  caseScorecardInput,
  previewAssertionLabel,
  selectTestRunTarget,
  testRunTargets,
  testRunVerdict,
} from "../test-run-model";
import { buildTestRunScorecard } from "../test-run-scorecard-model";

function run(id: string, model: string): EvalSuiteRun {
  return {
    _id: id,
    suiteId: "suite",
    runGroupId: "launch",
    namedHostId: "claude",
    effectiveModelId: model,
    runNumber: 4,
    status: "completed",
    configSnapshot: { tests: [], environment: { servers: [] } },
  } as unknown as EvalSuiteRun;
}

function iteration(
  id: string,
  runId: string,
  result: EvalIteration["result"],
  model: string,
): EvalIteration {
  return {
    _id: id,
    suiteRunId: runId,
    testCaseId: "case",
    status: result === "pending" ? "running" : "completed",
    result,
    resultSource: "reported",
    actualToolCalls: [],
    startedAt: 1000,
    updatedAt: 2000,
    testCaseSnapshot: {
      title: "Sketch a two-node flow",
      model,
      provider: "openai",
      query: "Draw it",
      expectedToolCalls: [],
    },
  } as unknown as EvalIteration;
}

const runA = run("run-a", "gpt-5-mini");
const runB = run("run-b", "claude-haiku-4.5");
const rows = [
  iteration("a1", "run-a", "passed", "gpt-5-mini"),
  iteration("a2", "run-a", "failed", "gpt-5-mini"),
  iteration("b1", "run-b", "passed", "claude-haiku-4.5"),
];

describe("testRunTargets", () => {
  it("gives each model of the launch its own iterations of the case", () => {
    const targets = testRunTargets({
      run: runA,
      runs: [runB],
      iterations: rows,
    });
    expect(targets.map((target) => target.targetKey)).toEqual([
      "gpt-5-mini",
      "claude-haiku-4.5",
    ]);
    expect(caseIterations(targets[0]!, "case").map((row) => row._id)).toEqual([
      "a1",
      "a2",
    ]);
    expect(caseIterations(targets[1]!, "case").map((row) => row._id)).toEqual([
      "b1",
    ]);
  });

  it("selects the model the address names, else the first", () => {
    const targets = testRunTargets({
      run: runA,
      runs: [runB],
      iterations: rows,
    });
    expect(selectTestRunTarget(targets, "claude-haiku-4.5")?.targetKey).toBe(
      "claude-haiku-4.5",
    );
    expect(selectTestRunTarget(targets, "gone")?.targetKey).toBe("gpt-5-mini");
    expect(selectTestRunTarget(targets, undefined)?.targetKey).toBe(
      "gpt-5-mini",
    );
    expect(selectTestRunTarget([], "x")).toBeNull();
  });
});

describe("testRunVerdict", () => {
  it.each([
    [[], "No iterations yet", 0, 0],
    [["passed", "passed"], "Passed", 2, 2],
    [["passed", "failed"], "Failed", 1, 2],
    [["passed", "pending"], "In progress", 1, 2],
  ] as const)("reads %j as %s", (results, word, passed, total) => {
    const verdict = testRunVerdict(
      results.map((result, index) =>
        iteration(String(index), "run-a", result, "m"),
      ),
    );
    expect(verdict).toMatchObject({ word, passed, total });
  });
});

describe("previewAssertionLabel", () => {
  const assert = (assertion: AssertStep["assertion"]): AssertStep => ({
    id: "a",
    kind: "assert",
    assertion,
  });
  it("names the tool a tool assertion checks", () => {
    expect(
      previewAssertionLabel(
        assert({
          type: "toolCalledWith",
          toolName: "read_me",
          args: { args: {} },
        }),
      ),
    ).toBe("Tool was called with “read_me”");
  });
  it("uses the kind's label otherwise", () => {
    expect(previewAssertionLabel(assert({ type: "noToolErrors" }))).toBe(
      "No tool errors so far",
    );
  });
});

describe("caseScorecardInput", () => {
  const suiteDefault: Predicate = { type: "toolCallCountUnder", count: 5 };
  const caseOwn: Predicate = { type: "responseContains", needle: "done" };
  const steps: TestStep[] = [
    { id: "p1", kind: "prompt", prompt: "Draw a two-node flow" },
    {
      id: "a1",
      kind: "assert",
      assertion: {
        type: "toolCalledWith",
        toolName: "read_me",
        args: { args: {} },
      },
    },
  ];
  const testCase = {
    _id: "case",
    title: "Sketch",
    steps,
    expectedOutput: "Two nodes joined",
    predicates: { mode: "extend", list: [caseOwn] },
  } as unknown as EvalCase;

  it("previews steps, then the outcome, then suite defaults before the case's own", () => {
    const input = caseScorecardInput(testCase, {
      defaultPredicates: [suiteDefault],
      judgeConfig: {
        goalCompletion: { enabled: true, autoRun: true, role: "advisory" },
      },
    });
    expect(input.toolsChoice).toBe("tools");
    const items = buildExecutionPreview(input.steps, buildCaseScorecard(input));
    expect(items.map((item) => item.kind)).toEqual([
      "prompt",
      "assertion",
      "outcome",
      "endOfRun",
    ]);
    const end = items.at(-1);
    expect(
      end?.kind === "endOfRun" && end.assertions.map((a) => a.provenance),
    ).toEqual(["suite", "case"]);
  });
});

describe("buildTestRunScorecard", () => {
  it("counts every iteration and the ones that timed out", () => {
    const scorecard = buildTestRunScorecard({
      iterations: [
        ...rows,
        iteration("t1", "run-a", "timed_out", "gpt-5-mini"),
      ],
      runFor: (row) => (row.suiteRunId === "run-a" ? runA : runB),
    });
    expect(scorecard.iterationCount).toBe(4);
    expect(scorecard.timedOut).toBe(1);
    for (const group of scorecard.groups) {
      for (const row of group.rows) {
        expect(row.passed).toBeLessThanOrEqual(row.measured);
        expect(row.measured).toBeLessThanOrEqual(4);
      }
    }
  });
});
