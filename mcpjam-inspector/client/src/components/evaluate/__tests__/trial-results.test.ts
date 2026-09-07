import { describe, expect, it } from "vitest";
import {
  buildEvaluationConfigSnapshot,
  definitionHash,
  finalizeScoreResult,
  resolveScoreDefinition,
  type ScoreDefinition,
  type ScoreResult,
} from "@mcpjam/sdk/contract";
import { hostedCriterionId } from "@/shared/hosted-criterion-id";
import type { Predicate } from "@/shared/eval-matching";
import type { TestStep } from "@/shared/steps";
import type { EvalIteration } from "@/components/evals/types";
import {
  buildCaseScorecard,
  type CaseScorecardInput,
} from "../case-scorecard/case-scorecard-model";
import {
  joinTrialResults,
  summarizeTrialScorecard,
  type JoinedScorecardRow,
  type TrialFacts,
} from "../case-scorecard/trial-results";
import { PASS_WORDS } from "./pass-words";

const prompt = (id: string, text: string): TestStep =>
  ({ id, kind: "prompt", prompt: text }) as TestStep;
const assert = (id: string, assertion: Predicate): TestStep =>
  ({ id, kind: "assert", assertion }) as TestStep;

const noToolErrors = { type: "noToolErrors" } as Predicate;
const finalNonEmpty = { type: "finalAssistantMessageNonEmpty" } as Predicate;

const steps = [prompt("p1", "hi"), assert("a1", noToolErrors)];

const authored: CaseScorecardInput = {
  steps,
  toolsChoice: "unset",
  predicates: { mode: "extend", list: [finalNonEmpty] },
};

function iteration(metadata: Record<string, unknown>): EvalIteration {
  return {
    _id: "it1",
    status: "completed",
    result: "passed",
    metadata,
  } as unknown as EvalIteration;
}

function join(
  input: CaseScorecardInput,
  trial: Partial<TrialFacts> & { iteration: EvalIteration | null },
): JoinedScorecardRow[] {
  const card = buildCaseScorecard(input);
  return joinTrialResults(card.groups, {
    steps: input.steps,
    ...trial,
  }).flatMap((group) => group.rows);
}

function rowByKey(rows: JoinedScorecardRow[], key: string) {
  const row = rows.find((r) => r.key === key);
  if (!row) throw new Error(`no row ${key}`);
  return row;
}

/** Build a real score row + config, the way the runner does. */
function scoreFixture(
  entries: Array<{
    definition: ScoreDefinition;
    result: Partial<ScoreResult> & Pick<ScoreResult, "status">;
  }>,
) {
  const config = buildEvaluationConfigSnapshot(
    entries.map((entry) => entry.definition),
  );
  const scores = entries.map((entry) => {
    const resolved = resolveScoreDefinition(entry.definition);
    return finalizeScoreResult(resolved, {
      status: entry.result.status,
      ...(entry.result.value !== undefined ? { value: entry.result.value } : {}),
      ...(entry.result.rationale ? { rationale: entry.result.rationale } : {}),
      ...(entry.result.error ? { error: entry.result.error } : {}),
      ...(entry.result.evidence ? { evidence: entry.result.evidence } : {}),
    } as never);
  });
  return { evaluationConfig: config, scores };
}

function predicateDefinition(
  predicate: Predicate,
  overrides: Partial<ScoreDefinition> = {},
): ScoreDefinition {
  return {
    scorerId: `predicate:${hostedCriterionId(predicate)}`,
    idSource: "platform",
    scorerVersion: "1",
    implementationHash: `impl-${predicate.type}`,
    deterministic: true,
    passThreshold: 1,
    role: "gating",
    ...overrides,
  };
}

describe("joinTrialResults — step rows", () => {
  it("shows the step's own verdict, with the reason the runner recorded", () => {
    const rows = join(authored, {
      iteration: iteration({
        stepResults: [
          {
            stepId: "a1",
            stepIndex: 1,
            kind: "assert",
            status: "fail",
            reason: "get_me returned isError",
          },
        ],
      }),
    });
    expect(rowByKey(rows, "step:a1").result).toEqual({
      state: "failed",
      source: "stepResult",
      reason: "get_me returned isError",
    });
  });

  it("says a step was skipped rather than calling it a failure", () => {
    // A failing gate halts the run, so later checks never evaluated. Counting
    // them as failures would blame them for a decision they took no part in.
    const rows = join(authored, {
      iteration: iteration({
        stepResults: [
          { stepId: "a1", stepIndex: 1, kind: "assert", status: "skipped" },
        ],
      }),
    });
    expect(rowByKey(rows, "step:a1").result.state).toBe("skipped");
  });

  it("falls back to the evaluator's sentence on a run that recorded no step verdicts", () => {
    const rows = join(authored, {
      iteration: iteration({
        predicates: [
          {
            predicate: noToolErrors,
            scope: { kind: "turn", promptIndex: 0 },
            passed: true,
            reason: "no tool reported an error",
          },
        ],
      }),
    });
    expect(rowByKey(rows, "step:a1").result).toEqual({
      state: "passed",
      source: "predicateResult",
      reason: "no tool reported an error",
    });
  });

  it("never joins a step-scoped check to the whole-run one", () => {
    // Same predicate, different claim: the step sees the transcript up to
    // itself, the case-level one sees all of it.
    const rows = join(
      { ...authored, predicates: { mode: "extend", list: [noToolErrors] } },
      {
        iteration: iteration({
          predicates: [
            { predicate: noToolErrors, passed: false, reason: "whole run" },
          ],
        }),
      },
    );
    expect(rowByKey(rows, "step:a1").result.state).toBe("notMeasured");
    expect(rowByKey(rows, "case:0").result).toMatchObject({
      state: "failed",
      reason: "whole run",
    });
  });

  it("reports a step still running as pending, and a finished one with no verdict as unmeasured", () => {
    const running = join(authored, {
      iteration: {
        ...iteration({}),
        status: "running",
      } as EvalIteration,
      liveStepStatusById: new Map([["a1", "running" as const]]),
    });
    expect(rowByKey(running, "step:a1").result.state).toBe("pending");

    const finished = join(authored, { iteration: iteration({}) });
    expect(rowByKey(finished, "step:a1").result.state).toBe("notMeasured");
  });
});

describe("joinTrialResults — case and suite rows", () => {
  it("joins on the criterion id the server minted", () => {
    const rows = join(authored, {
      iteration: iteration({
        predicates: [
          { predicate: finalNonEmpty, passed: true, reason: "answered" },
        ],
      }),
    });
    expect(rowByKey(rows, "case:0").result).toEqual({
      state: "passed",
      source: "predicateResult",
      reason: "answered",
    });
  });

  it("still joins after the check's role was changed", () => {
    // Policy is stripped from identity on purpose: a Gate → Warn edit must not
    // orphan the check's own history.
    const warned = { ...finalNonEmpty, role: "advisory", severity: "warn" } as Predicate;
    const rows = join(
      { ...authored, predicates: { mode: "extend", list: [warned] } },
      {
        iteration: iteration({
          predicates: [
            { predicate: finalNonEmpty, passed: false, reason: "empty answer" },
          ],
        }),
      },
    );
    expect(rowByKey(rows, "case:0").result).toMatchObject({
      state: "failed",
      reason: "empty answer",
    });
    expect(rowByKey(rows, "case:0").role).toBe("warn");
  });

  it("gives two identical checks the same result, because the server minted one scorer", () => {
    const rows = join(
      {
        ...authored,
        predicates: { mode: "extend", list: [finalNonEmpty, finalNonEmpty] },
      },
      {
        iteration: iteration({
          predicates: [
            { predicate: finalNonEmpty, passed: false, reason: "empty" },
          ],
        }),
      },
    );
    expect(rowByKey(rows, "case:0").result.state).toBe("failed");
    expect(rowByKey(rows, "case:1").result.state).toBe("failed");
  });

  it("reads error and skipped off the score row, which is the only source that has them", () => {
    const errored = scoreFixture([
      {
        definition: predicateDefinition(finalNonEmpty),
        result: { status: "error", error: "evaluator crashed" },
      },
    ]);
    const rows = join(authored, { iteration: iteration(errored) });
    const result = rowByKey(rows, "case:0").result;
    expect(result).toMatchObject({ state: "error", source: "scoreRow" });
    // An error always carries a sentence: a red mark with no reason is the
    // thing the Steps tab does today and the reason this pane exists.
    expect(result.state === "error" && result.reason.length).toBeGreaterThan(0);
  });

  it("refuses a score row whose definition is not the one on this trial", () => {
    // A row whose stamped hash matches no stored definition was produced under
    // a different configuration. Pairing it with the current one is the exact
    // substitution the integrity model exists to catch.
    const fixture = scoreFixture([
      {
        definition: predicateDefinition(finalNonEmpty),
        result: { status: "scored", value: 1 },
      },
    ]);
    const rows = join(authored, {
      iteration: iteration({
        scores: fixture.scores.map((score) => ({
          ...score,
          definitionHash: "not-a-real-hash",
        })),
        evaluationConfig: fixture.evaluationConfig,
      }),
    });
    expect(rowByKey(rows, "case:0").result.state).toBe("notMeasured");
  });

  it("says nothing rather than passing a row it could not join", () => {
    const rows = join(authored, { iteration: iteration({}) });
    for (const row of rows) {
      expect(row.result.state).not.toBe("passed");
    }
    expect(rowByKey(rows, "case:0").result).toEqual({ state: "notMeasured" });
  });

  it("names the role the trial was actually graded under when it has since changed", () => {
    const fixture = scoreFixture([
      {
        definition: predicateDefinition(finalNonEmpty, { role: "gating" }),
        result: { status: "scored", value: 0 },
      },
    ]);
    const warned = { ...finalNonEmpty, role: "advisory", severity: "warn" } as Predicate;
    const rows = join(
      { ...authored, predicates: { mode: "extend", list: [warned] } },
      { iteration: iteration(fixture) },
    );
    expect(rowByKey(rows, "case:0").evidence?.frozenRole).toBe("gating");
  });
});

describe("joinTrialResults — the route", () => {
  const routed: CaseScorecardInput = {
    steps: [prompt("p1", "hi")],
    toolsChoice: "noTool",
  };

  it("prefers the matcher's own score row", () => {
    const fixture = scoreFixture([
      {
        definition: {
          scorerId: "toolCalls:match",
          idSource: "platform",
          scorerVersion: "2",
          implementationHash: "impl-match",
          deterministic: true,
          passThreshold: 1,
          role: "gating",
        },
        result: { status: "scored", value: 0, rationale: "1 missing call" },
      },
    ]);
    const rows = join(routed, { iteration: iteration(fixture) });
    expect(rowByKey(rows, "route").result).toMatchObject({
      state: "failed",
      source: "scoreRow",
      reason: "1 missing call",
    });
  });

  it("falls back to the analyzer's selection verdict when there are no score rows", () => {
    const rows = join(routed, {
      iteration: iteration({}),
      chain: {
        status: "verified",
        analyzerVersion: 10,
        stages: [{ stage: "selection", state: "passed" }],
      } as never,
    });
    expect(rowByKey(rows, "route").result).toEqual({
      state: "passed",
      source: "chainSelection",
    });
  });

  it("does not read a chain the analyzer withheld", () => {
    // `unverified` is a refusal to project, not a set of neutral rows.
    const rows = join(routed, {
      iteration: iteration({}),
      chain: { status: "unverified" } as never,
    });
    expect(rowByKey(rows, "route").result.state).toBe("notMeasured");
  });

  it("treats a stage that was never reached as unmeasured, not as a route verdict", () => {
    const rows = join(routed, {
      iteration: iteration({}),
      chain: {
        status: "verified",
        analyzerVersion: 10,
        stages: [{ stage: "selection", state: "notReached" }],
      } as never,
    });
    expect(rowByKey(rows, "route").result.state).toBe("notMeasured");
  });
});

describe("joinTrialResults — the judge", () => {
  it("shows the verdict and the score it was measured against", () => {
    const rows = join(authored, {
      iteration: iteration({}),
      judgeCase: {
        caseKey: "c1",
        score: 0.82,
        passed: true,
        reason: "states the email address",
        rubricHits: [],
      } as never,
    });
    expect(rowByKey(rows, "judge:goalCompletion").result).toMatchObject({
      state: "passed",
      source: "judgeCase",
      value: 0.82,
    });
  });

  it("calls a judge that could not answer an error, not a low grade", () => {
    const rows = join(authored, {
      iteration: iteration({}),
      judgeCase: {
        caseKey: "c1",
        score: 0,
        passed: false,
        reason: "provider timed out",
        rubricHits: [],
        status: "error",
      } as never,
    });
    expect(rowByKey(rows, "judge:goalCompletion").result).toEqual({
      state: "error",
      source: "judgeCase",
      reason: "provider timed out",
    });
  });

  it("says the judge did not run rather than inventing a zero", () => {
    const rows = join(authored, { iteration: iteration({}) });
    expect(rowByKey(rows, "judge:goalCompletion").result).toEqual({
      state: "notMeasured",
    });
  });

  it("prefers the frozen threshold on the score row over a later suite edit", () => {
    const fixture = scoreFixture([
      {
        definition: {
          scorerId: "judge:goalCompletion",
          idSource: "platform",
          scorerVersion: "1",
          implementationHash: "impl-judge",
          deterministic: false,
          passThreshold: 0.9,
          role: "advisory",
        },
        result: { status: "scored", value: 0.82 },
      },
    ]);
    const rows = join(
      { ...authored, suiteJudgeConfig: { goalCompletion: { threshold: 0.5 } } },
      { iteration: iteration(fixture) },
    );
    expect(rowByKey(rows, "judge:goalCompletion").result).toMatchObject({
      state: "failed",
      value: 0.82,
      threshold: 0.9,
    });
  });
});

describe("summarizeTrialScorecard", () => {
  const rowsWith = (
    entries: Array<[JoinedScorecardRow["role"], JoinedScorecardRow["result"]]>,
  ) => [
    {
      rows: entries.map(([role, result], index) => ({
        key: `k${index}`,
        role,
        result,
      })) as unknown as JoinedScorecardRow[],
    },
  ];

  it("counts gates, and only gates", () => {
    const summary = summarizeTrialScorecard(
      rowsWith([
        ["gate", { state: "passed", source: "stepResult" }],
        ["gate", { state: "passed", source: "stepResult" }],
        ["warn", { state: "failed", source: "stepResult" }],
        ["report", { state: "failed", source: "stepResult" }],
      ]),
    );
    expect(summary.gates).toEqual({ passed: 2, counted: 2 });
    expect(summary.warn).toBe(1);
    expect(summary.report).toBe(1);
  });

  it("keeps an unmeasured gate out of the denominator", () => {
    // "1 of 2" for a scorer that never ran would claim a failure nobody saw.
    const summary = summarizeTrialScorecard(
      rowsWith([
        ["gate", { state: "passed", source: "stepResult" }],
        ["gate", { state: "notMeasured" }],
        ["gate", { state: "skipped", source: "stepResult" }],
      ]),
    );
    expect(summary.gates).toEqual({ passed: 1, counted: 1 });
    expect(summary.notMeasured).toBe(1);
  });

  it("counts a gating scorer that errored as counted but not passed", () => {
    const summary = summarizeTrialScorecard(
      rowsWith([["gate", { state: "error", source: "scoreRow", reason: "x" }]]),
    );
    expect(summary.gates).toEqual({ passed: 0, counted: 1 });
    expect(summary.errors).toBe(1);
  });
});

describe("honest states", () => {
  it("never labels an unjoined row with a pass word", () => {
    const rows = join(authored, { iteration: iteration({}) });
    for (const row of rows) {
      if (row.result.state !== "notMeasured") continue;
      expect(PASS_WORDS.test(row.result.state)).toBe(false);
    }
  });
});
