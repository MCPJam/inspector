import { describe, expect, it, vi } from "vitest";
import {
  buildEvaluationConfigSnapshot,
  definitionHash,
  finalizeScoreResult,
  resolveScoreDefinition,
  USER_VALUE_STAGES,
  type ScoreDefinition,
  type ScoreResult,
  type StageResultRow,
  type UserValueStage,
} from "@mcpjam/sdk/contract";
import { hostedCriterionId } from "@/shared/hosted-criterion-id";
import type { Predicate } from "@/shared/eval-matching";
import type { TestStep } from "@/shared/steps";
import type { EvalIteration } from "@/components/evals/types";
import {
  buildCaseScorecard,
  withRunnerChecks,
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
    // Policy is stripped from identity on purpose: a Required → Advisory edit
    // must not orphan the check's own history.
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
    expect(rowByKey(rows, "case:0").role).toBe("advisory");
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

describe("joinTrialResults — built-in runner checks", () => {
  /** A verified chain: every stage passed unless `over` says otherwise. */
  const chainWith = (
    over: Partial<Record<UserValueStage, Omit<StageResultRow, "stage">>> = {},
  ) =>
    ({
      status: "verified",
      analyzerVersion: 12,
      stages: USER_VALUE_STAGES.map((stage) => ({
        stage,
        state: "passed",
        reason: "observed",
        ...over[stage],
      })),
    } as TrialFacts["chain"]);

  /**
   * The run page's assembly: the chain's runner checks, then the join. (The
   * page then drops the ones the chain calls not applicable; this keeps them,
   * to test what the join says about them.)
   */
  function joinRun(
    trial: Partial<TrialFacts> & { iteration: EvalIteration | null },
  ): JoinedScorecardRow[] {
    const card = buildCaseScorecard(authored);
    const stages =
      trial.chain?.status === "verified"
        ? trial.chain.stages.map((row) => row.stage)
        : [];
    return joinTrialResults(withRunnerChecks(card.groups, stages), {
      steps: authored.steps,
      ...trial,
    }).flatMap((group) => group.rows);
  }

  it("reports the verified chain's verdict and reason, in its own words", () => {
    const rows = joinRun({
      iteration: iteration({}),
      chain: chainWith({
        connection: { state: "failed", reason: "connectFailed" },
      }),
    });
    expect(rowByKey(rows, "builtin:connection").result).toEqual({
      state: "failed",
      source: "chainStage",
      reason:
        "Failed because the configured server was reached and initialize failed there.",
    });
    expect(rowByKey(rows, "builtin:discovery").result).toEqual({
      state: "passed",
      source: "chainStage",
      reason: "Passed because the evidence was inspected and the stage held.",
    });
  });

  it("says not applicable, never ran and not measured the way the chain does", () => {
    const rows = joinRun({
      iteration: iteration({}),
      chain: chainWith({
        discovery: { state: "notReached", reason: "earlierStageFailed" },
        call: { state: "notApplicable", reason: "notAuthored" },
        response: { state: "notMeasured", reason: "noEvidenceCaptured" },
      }),
    });
    expect(rowByKey(rows, "builtin:discovery").result).toEqual({
      state: "skipped",
      source: "chainStage",
      reason: "Never ran (an earlier stage failed).",
    });
    expect(rowByKey(rows, "builtin:call").result).toEqual({
      state: "notApplicable",
      source: "chainStage",
      reason:
        "Not applicable to this case because the case asserts nothing this stage could decide.",
    });
    expect(rowByKey(rows, "builtin:response").result).toEqual({
      state: "notMeasured",
      source: "chainStage",
      reason:
        "Not measured because nothing eligible for that stage was captured.",
    });
  });

  it("reads nothing from a chain the analyzer withheld, or from none", () => {
    for (const chain of [
      { status: "unverified" } as TrialFacts["chain"],
      { status: "absent" } as TrialFacts["chain"],
      null,
    ]) {
      const rows = joinRun({ iteration: iteration({}), chain });
      const builtins = rows.filter((row) => row.provenance === "builtin");
      // Only the stages the case itself implies, and none of them measured.
      expect(builtins.map((row) => row.stage)).toEqual([
        "connection",
        "discovery",
        "response",
      ]);
      for (const row of builtins) {
        expect(row.result).toEqual({ state: "notMeasured" });
      }
    }
  });

  it("calls a setup failure an error, and keeps what the setup signals measured", () => {
    const setupFailed = { ...iteration({}), status: "setup_failed" };
    const aborted = joinRun({
      iteration: setupFailed as EvalIteration,
      chain: chainWith({
        connection: { state: "failed", reason: "connectFailed" },
        discovery: { state: "notReached", reason: "earlierStageFailed" },
        response: { state: "notReached", reason: "earlierStageFailed" },
      }),
    });
    // A stage the setup signals measured keeps its measured verdict…
    expect(rowByKey(aborted, "builtin:connection").result.state).toBe("failed");
    // …and one nothing measured could not be evaluated.
    expect(rowByKey(aborted, "builtin:discovery").result).toEqual({
      state: "error",
      source: "chainStage",
      reason: "The environment was never prepared, so the test never began.",
    });
    // With no chain at all the status alone still says so.
    const bare = joinRun({ iteration: setupFailed as EvalIteration });
    for (const row of bare.filter((r) => r.provenance === "builtin")) {
      expect(row.result.state).toBe("error");
    }
  });

  it("quotes the sentence the failing tool returned, as evidence under the verdict", () => {
    const rows = joinRun({
      iteration: iteration({}),
      chain: chainWith({ response: { state: "failed", reason: "toolError" } }),
      trace: {
        messages: [
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call-1",
                toolName: "create_journey",
                result: {
                  isError: true,
                  content: [
                    { type: "text", text: "VALIDATION_ERROR: no host" },
                  ],
                },
              },
            ],
          },
        ],
      },
    });
    const response = rowByKey(rows, "builtin:response");
    expect(response.result).toMatchObject({
      state: "failed",
      reason: "Failed because the server reported a tool error.",
    });
    expect(response.evidence?.floor).toBe(
      "`create_journey` returned an error: VALIDATION_ERROR: no host",
    );
    // A stage that held has no failure to quote.
    expect(rowByKey(rows, "builtin:connection").evidence).toBeUndefined();
  });

  /** A trace whose one tool call came back an error: a floor to quote. */
  const erroredTrace = {
    messages: [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "create_journey",
            result: {
              isError: true,
              content: [{ type: "text", text: "VALIDATION_ERROR: no host" }],
            },
          },
        ],
      },
    ],
  } as TrialFacts["trace"];

  it.each([
    [
      "connection",
      "connectFailed",
      "Failed because the configured server was reached and initialize failed there.",
    ],
    [
      "discovery",
      "toolsListFailed",
      "Failed because initialize succeeded and listing tools failed.",
    ],
    ["call", "protocolError", "Failed because the call never produced a result."],
    ["response", "toolError", "Failed because the server reported a tool error."],
  ] as const)(
    "fails %s on the reason the runner owns there (%s)",
    (stage, reason, sentence) => {
      const rows = joinRun({
        iteration: iteration({}),
        chain: chainWith({ [stage]: { state: "failed", reason } }),
      });
      expect(rowByKey(rows, `builtin:${stage}`).result).toEqual({
        state: "failed",
        source: "chainStage",
        reason: sentence,
      });
    },
  );

  // Each failure an evaluator owns at a runner-checked stage. The runner check
  // says so and stays undecided: not failed (the runner's own measurement did
  // not break, and the failure already has its evaluator's row), and not
  // passed (the analysis stops at the first failing reason, so the runner's
  // check behind it may never have been read).
  it.each([
    [
      "discovery",
      "predicateFailed",
      "a required discovery assertion",
      "Decided by an evaluator: an assertion on the result did not hold.",
    ],
    [
      "call",
      "argumentMismatch",
      "the matcher, or a failed call-kind assertion",
      "Decided by an evaluator: the call arguments did not match what the case expects.",
    ],
    [
      "response",
      "predicateFailed",
      "a required response assertion",
      "Decided by an evaluator: an assertion on the result did not hold.",
    ],
    [
      "response",
      "renderFailed",
      "a widget assertion",
      "Decided by an evaluator: the widget did not render.",
    ],
  ] as const)(
    "leaves %s undecided when %s came from %s",
    (stage, reason, _source, sentence) => {
      const rows = joinRun({
        iteration: iteration({}),
        chain: chainWith({ [stage]: { state: "failed", reason } }),
        trace: erroredTrace,
      });
      const row = rowByKey(rows, `builtin:${stage}`);
      expect(row.result).toEqual({
        state: "notMeasured",
        source: "chainStage",
        reason: sentence,
      });
      // …and quotes no floor: that belongs to the stage, not to this row.
      expect(row.evidence).toBeUndefined();
    },
  );
});

describe("joinTrialResults — the route's arguments", () => {
  const routedInput: CaseScorecardInput = {
    steps: [
      prompt("p1", "who am I?"),
      assert("t1", {
        type: "toolCalledWith",
        toolName: "get_me",
        args: { args: { id: 7 } },
      } as Predicate),
    ],
    toolsChoice: "tools",
  };
  const argumentsDefinition: ScoreDefinition = {
    scorerId: "toolCalls:arguments",
    idSource: "platform",
    scorerVersion: "1",
    implementationHash: "impl:arguments",
    deterministic: true,
    passThreshold: 1,
    role: "gating",
  };

  it("reads its own score row", () => {
    const fixture = scoreFixture([
      {
        definition: argumentsDefinition,
        result: {
          status: "scored",
          value: 0,
          rationale: "`get_me` was called with a different `id` than expected",
        },
      },
    ]);
    const rows = join(routedInput, { iteration: iteration(fixture) });
    expect(rowByKey(rows, "route:arguments").result).toMatchObject({
      state: "failed",
      source: "scoreRow",
      reason: "`get_me` was called with a different `id` than expected",
    });
  });

  it("never borrows the call stage's verdict, which is not about arguments", () => {
    const fixture = scoreFixture([
      { definition: argumentsDefinition, result: { status: "skipped" } },
    ]);
    // Declared, with no scored row: not measured, whatever the chain says.
    const rows = join(routedInput, {
      iteration: iteration({
        evaluationConfig: fixture.evaluationConfig,
        scores: [],
      }),
      chain: {
        status: "verified",
        analyzerVersion: 12,
        stages: [{ stage: "call", state: "failed", reason: "protocolError" }],
      } as TrialFacts["chain"],
    });
    expect(rowByKey(rows, "route:arguments").result).toEqual({
      state: "notMeasured",
    });
  });

  it("is not on a trial graded before the split, which checked arguments in the route row", () => {
    for (const metadata of [
      {},
      scoreFixture([
        {
          definition: { ...argumentsDefinition, scorerId: "toolCalls:match" },
          result: { status: "scored", value: 1 },
        },
      ]),
    ]) {
      const rows = join(routedInput, { iteration: iteration(metadata) });
      expect(rows.map((row) => row.key)).not.toContain("route:arguments");
      expect(rows.map((row) => row.key)).toContain("route");
    }
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

  it("counts required rows, and only required rows", () => {
    const summary = summarizeTrialScorecard(
      rowsWith([
        ["required", { state: "passed", source: "stepResult" }],
        ["required", { state: "passed", source: "stepResult" }],
        ["advisory", { state: "failed", source: "stepResult" }],
        ["advisory", { state: "failed", source: "stepResult" }],
      ]),
    );
    expect(summary.required).toEqual({ passed: 2, counted: 2 });
    // One advisory tally, not a warn/report split.
    expect(summary.advisory).toBe(2);
  });

  it("keeps an unmeasured required row out of the denominator", () => {
    // "1 of 2" for a scorer that never ran would claim a failure nobody saw.
    const summary = summarizeTrialScorecard(
      rowsWith([
        ["required", { state: "passed", source: "stepResult" }],
        ["required", { state: "notMeasured" }],
        ["required", { state: "skipped", source: "stepResult" }],
      ]),
    );
    expect(summary.required).toEqual({ passed: 1, counted: 1 });
    expect(summary.notMeasured).toBe(1);
  });

  it("never counts a runner check, which decides nothing", () => {
    const summary = summarizeTrialScorecard([
      {
        rows: [
          {
            key: "builtin:connection",
            provenance: "builtin",
            role: "advisory",
            result: { state: "failed", source: "chainStage" },
          },
          {
            key: "builtin:discovery",
            provenance: "builtin",
            role: "advisory",
            result: { state: "error", source: "chainStage", reason: "x" },
          },
        ] as unknown as JoinedScorecardRow[],
      },
    ]);
    expect(summary).toEqual({
      required: { passed: 0, counted: 0 },
      advisory: 0,
      errors: 0,
      notMeasured: 0,
      pending: 0,
    });
  });

  it("counts a required scorer that errored as counted but not passed", () => {
    const summary = summarizeTrialScorecard(
      rowsWith([
        ["required", { state: "error", source: "scoreRow", reason: "x" }],
      ]),
    );
    expect(summary.required).toEqual({ passed: 0, counted: 1 });
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

it.each([
  ["ok", "passed"],
  ["fail", "failed"],
] as const)(
  "shows live %s before a step result is persisted",
  (status, state) => {
    const rows = join(authored, {
      iteration: { ...iteration({}), status: "running" },
      liveStepStatusById: new Map([["a1", status]]),
    });
    expect(rowByKey(rows, "step:a1").result.state).toBe(state);
  },
);

describe("the trace narrative join", () => {
  const report = (
    rows: Array<{ joinKey: string; verdictSeen: string; actual: string }>,
    status: "ready" | "stale" = "ready",
  ) =>
    ({
      schemaVersion: 1,
      iterationId: "it1",
      runRevision: "r",
      builtAt: 0,
      status,
      rows: rows.map((row) => ({
        ...row,
        stage: "userValue",
        citations: ["m:0"],
      })),
      stageNotes: [],
    }) as unknown as TrialFacts["report"];

  const judgeKey = "judge:goalCompletion";
  const failedJudge = {
    caseKey: "c1",
    score: 0.1,
    passed: false,
    reason: "The server was never saved.",
    rubricHits: [],
  } as never;

  it("gives a row the note minted for its own scorer id", () => {
    const rows = join(authored, {
      iteration: iteration({}),
      judgeCase: failedJudge,
      report: report([
        { joinKey: judgeKey, verdictSeen: "failed", actual: "It never saved." },
      ]),
    });
    expect(rowByKey(rows, "judge:goalCompletion").narrative).toMatchObject({
      text: "It never saved.",
      stale: false,
    });
  });

  it("marks a note stale when the grade moved under it", () => {
    const rows = join(authored, {
      iteration: iteration({}),
      judgeCase: failedJudge,
      report: report([
        // The report saw a pass; the recorded verdict now says failed.
        { joinKey: judgeKey, verdictSeen: "passed", actual: "It saved." },
      ]),
    });
    expect(rowByKey(rows, "judge:goalCompletion").narrative?.stale).toBe(true);
  });

  it("marks every note stale when the report itself is stale", () => {
    const rows = join(authored, {
      iteration: iteration({}),
      judgeCase: failedJudge,
      report: report(
        [
          {
            joinKey: judgeKey,
            verdictSeen: "failed",
            actual: "It never saved.",
          },
        ],
        "stale",
      ),
    });
    expect(rowByKey(rows, "judge:goalCompletion").narrative?.stale).toBe(true);
  });

  it("refuses to pick between two notes claiming one scorer", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rows = join(authored, {
      iteration: iteration({}),
      judgeCase: failedJudge,
      report: report([
        { joinKey: judgeKey, verdictSeen: "failed", actual: "One story." },
        { joinKey: judgeKey, verdictSeen: "failed", actual: "Another story." },
      ]),
    });
    expect(rowByKey(rows, "judge:goalCompletion").narrative).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("leaves a keyless row alone rather than matching it to anything", () => {
    // A step-authored check with no criterion id mints no scorer id. An
    // `undefined` key must match nothing, not every note without one.
    const rows = join(authored, {
      iteration: iteration({}),
      report: report([
        { joinKey: "predicate:whatever", verdictSeen: "passed", actual: "x" },
      ]),
    });
    expect(rowByKey(rows, "step:a1").narrative).toBeUndefined();
  });

  it("gives a predicate-only iteration its narrative, joined by criterion id", () => {
    // The population the backend's evaluator list used to skip entirely: an
    // iteration that recorded `metadata.predicates` and no score rows. The
    // report's key for such a row is `predicate:<hostedCriterionId>` — the same
    // string this file joins on — so the narrative lands and is not stale.
    const rows = join(authored, {
      iteration: iteration({
        predicates: [
          {
            predicate: noToolErrors,
            // An authored assert step always sits inside a turn, so its
            // criterion id is the SCOPED one.
            scope: { kind: "turn", promptIndex: 0 },
            passed: true,
            reason: "no tool errors",
          },
          { predicate: finalNonEmpty, passed: false, reason: "empty answer" },
        ],
      }),
      report: report([
        {
          joinKey: `predicate:${hostedCriterionId(noToolErrors, {
            kind: "turn",
            promptIndex: 0,
          })}`,
          verdictSeen: "passed",
          actual: "Every tool call came back clean.",
        },
        {
          joinKey: `predicate:${hostedCriterionId(finalNonEmpty)}`,
          verdictSeen: "failed",
          actual: "The assistant stopped without answering.",
        },
      ]),
    });
    expect(rowByKey(rows, "step:a1").narrative).toMatchObject({
      text: "Every tool call came back clean.",
      stale: false,
    });
    expect(rowByKey(rows, "case:0").narrative).toMatchObject({
      text: "The assistant stopped without answering.",
      stale: false,
    });
  });

  it("leaves an uncovered row with its recorded observation and no narrative", () => {
    // Partial coverage is the normal case, not a failure: a `ready` report may
    // speak to some evaluators and not others. The rows it skipped must still
    // show what was recorded — never an empty line, and never a borrowed one.
    const rows = join(authored, {
      iteration: iteration({
        predicates: [
          {
            predicate: noToolErrors,
            scope: { kind: "turn", promptIndex: 0 },
            passed: true,
            reason: "no tool errors",
          },
          { predicate: finalNonEmpty, passed: false, reason: "empty answer" },
        ],
      }),
      report: report([
        {
          joinKey: `predicate:${hostedCriterionId(noToolErrors, {
            kind: "turn",
            promptIndex: 0,
          })}`,
          verdictSeen: "passed",
          actual: "Every tool call came back clean.",
        },
      ]),
    });
    expect(rowByKey(rows, "step:a1").narrative).toBeDefined();
    const uncovered = rowByKey(rows, "case:0");
    expect(uncovered.narrative).toBeUndefined();
    expect(uncovered.result).toMatchObject({
      state: "failed",
      source: "predicateResult",
      reason: "empty answer",
    });
  });

  it("keeps a scoped check's narrative off the whole-run check with the same predicate", () => {
    // Turn scope is part of the criterion id, so the two are different
    // scorers. A narrative written for one must never be worn by the other.
    const scopedSteps = [
      prompt("p1", "first"),
      assert("a1", noToolErrors),
      prompt("p2", "second"),
      assert("a2", noToolErrors),
    ];
    const rows = join(
      {
        ...authored,
        steps: scopedSteps,
        // The SAME check authored at case level too, so the whole-run scorer
        // this test is named for is actually on the card. Without it the card
        // holds only turn-scoped rows and a regression that conflated a scoped
        // criterion with its unscoped twin would still pass.
        predicates: { mode: "extend", list: [noToolErrors] },
      },
      {
        iteration: iteration({
          predicates: [
            {
              predicate: noToolErrors,
              scope: { kind: "turn", promptIndex: 0 },
              passed: true,
              reason: "turn 0 clean",
            },
            {
              predicate: noToolErrors,
              scope: { kind: "turn", promptIndex: 1 },
              passed: false,
              reason: "turn 1 errored",
            },
            {
              predicate: noToolErrors,
              passed: false,
              reason: "one turn errored over the whole run",
            },
          ],
        }),
        report: report([
          {
            joinKey: `predicate:${hostedCriterionId(noToolErrors, {
              kind: "turn",
              promptIndex: 1,
            })}`,
            verdictSeen: "failed",
            actual: "The second turn hit a tool error.",
          },
        ]),
      },
    );
    expect(rowByKey(rows, "step:a2").narrative).toMatchObject({
      text: "The second turn hit a tool error.",
      stale: false,
    });
    expect(rowByKey(rows, "step:a1").narrative).toBeUndefined();
    expect(rowByKey(rows, "step:a1").result).toMatchObject({
      state: "passed",
      reason: "turn 0 clean",
    });
    // The whole-run scorer sees the same predicate and the same failure, and
    // still gets no narrative: the turn-1 note was written about one turn.
    const wholeRun = rowByKey(rows, "case:0");
    expect(wholeRun.narrative).toBeUndefined();
    expect(wholeRun.result).toMatchObject({
      state: "failed",
      source: "predicateResult",
      reason: "one turn errored over the whole run",
    });
  });

  it("marks a predicate narrative stale when a step verdict outranks it", () => {
    // A step row reads `stepResults` before the predicate row. A report whose
    // verdict came from the predicate row therefore describes a different
    // outcome, and says so rather than reading as current.
    const rows = join(authored, {
      iteration: iteration({
        predicates: [
          {
            predicate: noToolErrors,
            scope: { kind: "turn", promptIndex: 0 },
            passed: true,
            reason: "no tool errors",
          },
        ],
        stepResults: [
          { stepId: "a1", stepIndex: 1, kind: "assert", status: "skipped" },
        ],
      }),
      report: report([
        {
          joinKey: `predicate:${hostedCriterionId(noToolErrors, {
            kind: "turn",
            promptIndex: 0,
          })}`,
          verdictSeen: "passed",
          actual: "Every tool call came back clean.",
        },
      ]),
    });
    expect(rowByKey(rows, "step:a1").result.state).toBe("skipped");
    expect(rowByKey(rows, "step:a1").narrative?.stale).toBe(true);
  });

  it("leaves every row alone when no report exists", () => {
    const rows = join(authored, { iteration: iteration({}) });
    expect(rows.every((row) => row.narrative === undefined)).toBe(true);
  });
});
