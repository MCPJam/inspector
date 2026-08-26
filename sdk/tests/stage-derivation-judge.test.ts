/**
 * Judge evidence as a TIER-2 input to `userValue`.
 *
 * The whole property under test is subordination: an advisory, non-deterministic
 * grader may only speak where deterministic evidence is silent. Every test here
 * is either "the judge was consulted because nothing else knew" or "the judge
 * was ignored because something else did".
 */

import { describe, expect, test } from "vitest";
import {
  MAX_EVIDENCE_REASONS,
  MAX_EVIDENCE_REASON_CHARS,
  STAGE_ANALYZER_VERSION,
  STAGE_REASONS,
  deriveStageResults,
  type StageAuthoredCase,
  type StageDerivationInput,
  type StageEvidence,
  type StageResultRow,
} from "../src/contract/index.js";

const modelDrivenCase: StageAuthoredCase = {
  mode: "model_driven",
  expectsToolCall: true,
  assertionCount: 1,
};

const toolSpan = {
  id: "s1",
  category: "tool",
  status: "ok",
  toolName: "list_files",
  promptIndex: 0,
};

const cleanTurn = {
  promptIndex: 0,
  missing: [],
  unexpected: [],
  argumentMismatches: [],
  passed: true,
};

type JudgeEvidence = NonNullable<StageEvidence["judgeEvidence"]>;

/** A traced iteration with no predicate results: judge-decidable. */
function derive(
  judgeEvidence: JudgeEvidence | undefined,
  over: Partial<StageDerivationInput> = {}
) {
  return deriveStageResults({
    authored: modelDrivenCase,
    evidence: {
      spans: [toolSpan],
      prompts: [cleanTurn],
      ...(judgeEvidence ? { judgeEvidence } : {}),
    },
    iteration: { status: "completed" },
    ...over,
  });
}

const userValue = (rows: StageResultRow[]) =>
  rows.find((row) => row.stage === "userValue")!;

describe("the mirror the backend pins against", () => {
  test("carries the five judge reasons, in the analyzer version that added them", () => {
    expect(STAGE_ANALYZER_VERSION).toBe(4);
    for (const reason of [
      "judgeObserved",
      "judgePartial",
      "judgeFailed",
      "judgePending",
      "judgeNotRequested",
    ]) {
      expect(STAGE_REASONS).toContain(reason);
    }
  });
});

describe("a scored verdict decides userValue when nothing deterministic did", () => {
  test("pass → passed / judgeObserved", () => {
    expect(derive({ status: "scored", verdict: "pass" }).stageResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "userValue",
          state: "passed",
          reason: "judgeObserved",
        }),
      ])
    );
  });

  test("partial is a FAILURE, not a fifth kind of pass", () => {
    const { stageResults, firstFailedStage, failureCategory } = derive({
      status: "scored",
      verdict: "partial",
    });
    expect(userValue(stageResults)).toMatchObject({
      state: "failed",
      reason: "judgePartial",
    });
    expect(firstFailedStage).toBe("userValue");
    // No new category: a judge-decided failure buckets exactly where a
    // predicate-decided one does.
    expect(failureCategory).toBe("userValue");
  });

  test("fail → failed / judgeFailed, category userValue", () => {
    const { stageResults, failureCategory } = derive({
      status: "scored",
      verdict: "fail",
    });
    expect(userValue(stageResults)).toMatchObject({
      state: "failed",
      reason: "judgeFailed",
    });
    expect(failureCategory).toBe("userValue");
  });

  test("a broken grader is notMeasured / evaluatorError, category evaluator", () => {
    const { stageResults, failureCategory } = derive({ status: "error" });
    expect(userValue(stageResults)).toMatchObject({
      state: "notMeasured",
      reason: "evaluatorError",
    });
    expect(failureCategory).toBeUndefined();
  });

  test("scored with no band cannot decide anything", () => {
    expect(userValue(derive({ status: "scored" }).stageResults)).toMatchObject({
      state: "notMeasured",
      reason: "noEvidenceCaptured",
    });
  });
});

describe("what the judge is not allowed to touch", () => {
  test("a failed predicate stands, even against a passing judge", () => {
    const { stageResults } = derive({ status: "scored", verdict: "pass" }, {
      evidence: {
        spans: [toolSpan],
        prompts: [cleanTurn],
        predicateResults: [{ passed: false, reason: "wrong city" }],
        judgeEvidence: { status: "scored", verdict: "pass" },
      },
    });
    expect(userValue(stageResults)).toMatchObject({
      state: "failed",
      reason: "predicateFailed",
    });
  });

  test("a passing predicate stands, even against a failing judge", () => {
    const { stageResults } = derive(undefined, {
      evidence: {
        spans: [toolSpan],
        prompts: [cleanTurn],
        predicateResults: [{ passed: true, reason: "ok" }],
        judgeEvidence: { status: "scored", verdict: "fail" },
      },
    });
    expect(userValue(stageResults)).toMatchObject({
      state: "passed",
      reason: "observed",
    });
  });

  test("an evaluator error still wins the first slot", () => {
    const { stageResults } = derive(undefined, {
      evidence: {
        spans: [toolSpan],
        prompts: [cleanTurn],
        evaluatorErrored: true,
        judgeEvidence: { status: "scored", verdict: "pass" },
      },
    });
    expect(userValue(stageResults)).toMatchObject({
      state: "notMeasured",
      reason: "evaluatorError",
    });
  });

  test("an untraced run is not judgeable", () => {
    const { stageResults } = derive(undefined, {
      evidence: {
        traceAbsent: true,
        judgeEvidence: { status: "scored", verdict: "pass" },
      },
    });
    expect(userValue(stageResults)).toMatchObject({
      state: "notMeasured",
      reason: "traceAbsent",
    });
  });
});

describe("nothing to say", () => {
  test("skipped and not_applicable fall through to the floor", () => {
    for (const status of ["skipped", "not_applicable"] as const) {
      expect(userValue(derive({ status }).stageResults)).toMatchObject({
        state: "notMeasured",
        reason: "noEvidenceCaptured",
      });
    }
  });

  test("a scheduled verdict that has not arrived is judgePending", () => {
    expect(
      userValue(
        derive({ status: "pending", pendingKind: "scheduled" }).stageResults
      )
    ).toMatchObject({ state: "notMeasured", reason: "judgePending" });
  });

  test("a verdict that was never owed is judgeNotRequested", () => {
    expect(
      userValue(
        derive({ status: "pending", pendingKind: "not_requested" }).stageResults
      )
    ).toMatchObject({ state: "notMeasured", reason: "judgeNotRequested" });
  });

  test("pending with no kind reads as scheduled — a verdict may still arrive", () => {
    // `not_requested` is the stronger claim (nobody ever owed one) and is only
    // made when the caller says so.
    expect(userValue(derive({ status: "pending" }).stageResults)).toMatchObject({
      state: "notMeasured",
      reason: "judgePending",
    });
  });

  test("no judge evidence at all is indistinguishable from before this wave", () => {
    expect(userValue(derive(undefined).stageResults)).toMatchObject({
      state: "notMeasured",
      reason: "noEvidenceCaptured",
    });
  });
});

describe("judge reasons obey the existing evidence bounds", () => {
  test("count and length are capped like every other evidence source", () => {
    const { stageResults } = derive({
      status: "scored",
      verdict: "fail",
      reasons: Array.from(
        { length: MAX_EVIDENCE_REASONS + 5 },
        (_, index) => `${index}:${"r".repeat(MAX_EVIDENCE_REASON_CHARS + 40)}`
      ),
    });
    // Judge reasons reuse `predicateReasons`, the refs type's only free-text
    // slot, rather than widening a mirrored shape.
    const evidence = userValue(stageResults).evidence?.predicateReasons ?? [];
    expect(evidence.length).toBe(MAX_EVIDENCE_REASONS);
    for (const entry of evidence) {
      expect(entry.length).toBeLessThanOrEqual(MAX_EVIDENCE_REASON_CHARS);
    }
  });

  test("non-string junk in reasons is dropped, not rendered", () => {
    const { stageResults } = derive({
      status: "scored",
      verdict: "fail",
      reasons: ["real reason", "", "   "],
    });
    expect(userValue(stageResults).evidence?.predicateReasons).toEqual([
      "real reason",
    ]);
  });
});
