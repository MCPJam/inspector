/**
 * The hero's claims, and the two it must never make.
 *
 * A hero is the most-read thing on the page, so the failures that matter are
 * over-claims: saying "Passed" from a decision this page never read, and
 * naming a break location the contract declined to establish. Both are tested
 * directly rather than through a render, because they are properties of the
 * model and would survive any restyling of the view.
 */
import { describe, expect, it } from "vitest";
import {
  USER_VALUE_STAGES,
  evalRunDecisionSummaryStructuralSchema,
  type EvalRunDecisionDiagnostic,
  type EvalRunDecisionSummary,
  type StageResultRow,
  type StageState,
  type UserValueStage,
} from "@mcpjam/sdk/contract";

import { PASS_WORDS } from "./pass-words";
import {
  buildRunVerdictHero,
  selectHeroFocus,
  type RunVerdictHeroInput,
} from "../run-verdict-hero-model";
import type { EvalIteration, EvalSuiteRun } from "../../evals/types";

function chainRows(
  states: Partial<Record<UserValueStage, StageState>> = {},
  reasons: Partial<Record<UserValueStage, string>> = {},
): StageResultRow[] {
  return USER_VALUE_STAGES.map(
    (stage) =>
      ({
        stage,
        state: states[stage] ?? "passed",
        ...(reasons[stage] ? { reason: reasons[stage] } : {}),
      }) as StageResultRow,
  );
}

function diagnostic(
  overrides: Partial<EvalRunDecisionDiagnostic> = {},
): EvalRunDecisionDiagnostic {
  return {
    iterationId: "it_1",
    iterationNumber: 1,
    title: "Draw and share a diagram",
    status: "completed",
    result: "failed",
    chain: {
      status: "verified",
      stages: chainRows(
        { selection: "failed", call: "notReached", response: "notReached" },
        { selection: "missingToolCall" },
      ),
      firstFailedStage: "selection",
      failureCategory: "selection",
      stageAnalyzerVersion: 8,
    },
    expected: { toolNames: ["export_to_excalidraw"] },
    observed: { toolNames: ["create_view"] },
    evidence: {
      runId: "run_1",
      iterationId: "it_1",
      stage: "selection",
      tracePath: "/v1/projects/p/eval-runs/run_1/iterations/it_1/trace",
    },
    nextAction: "review tool selection and the tool catalog",
    ...overrides,
  } as EvalRunDecisionDiagnostic;
}

/**
 * A summary fixture, PARSED rather than cast.
 *
 * The first draft of this helper used a `verdictSource` that is not in the
 * vocabulary, and the `as` hid it until a label lookup rendered the literal
 * word "undefined" into a caveat line. Structural rather than refined, because
 * these fixtures deliberately pair a verdict with a source the cross-field
 * rules would reject, in order to exercise the renderer's own states.
 */
function summary(
  overrides: Partial<EvalRunDecisionSummary> = {},
): EvalRunDecisionSummary {
  return evalRunDecisionSummaryStructuralSchema.parse({
    schemaVersion: 1,
    runId: "run_1",
    runStatus: "completed",
    verdict: "failed",
    verdictSource: "legacy",
    counts: { measurementUnit: "trial", total: 3, passed: 2, failed: 1 },
    diagnostics: {
      items: [],
      complete: true,
      scannedIterations: 3,
    },
    ...overrides,
  }) as EvalRunDecisionSummary;
}

function iteration(overrides: Partial<EvalIteration> = {}): EvalIteration {
  return {
    _id: "it_1",
    status: "completed",
    result: "passed",
    tokensUsed: 1000,
    actualToolCalls: [{ toolName: "create_view", arguments: {} }],
    ...overrides,
  } as unknown as EvalIteration;
}

const RUN = { _id: "run_1", status: "completed" } as unknown as EvalSuiteRun;

function input(
  overrides: Partial<RunVerdictHeroInput> = {},
): RunVerdictHeroInput {
  return {
    run: RUN,
    iterations: [iteration()],
    decision: { status: "ready", summary: summary(), diagnostics: [] },
    ...overrides,
  };
}

describe("the verdict word", () => {
  it("says the decision's own verdict, never a recomputed one", () => {
    for (const [verdict, word] of [
      ["passed", "Passed"],
      ["failed", "Failed"],
      ["inconclusive", "Inconclusive"],
      ["notEstablished", "No verdict"],
    ] as const) {
      const view = buildRunVerdictHero(
        input({
          decision: {
            status: "ready",
            summary: summary({ verdict }),
            diagnostics: [],
          },
        }),
      );
      expect(view.verdict.word, verdict).toBe(word);
    }
  });

  it("paints inconclusive amber, never red", () => {
    // Red is a claim that something broke. An inconclusive run measured too
    // little to say that, so red would report a defect nobody observed.
    const view = buildRunVerdictHero(
      input({
        decision: {
          status: "ready",
          summary: summary({ verdict: "inconclusive" }),
          diagnostics: [],
        },
      }),
    );
    expect(view.verdict.tone).toBe("caution");
  });

  it("INVARIANT: never says passed from a decision it did not read", () => {
    // The whole point. A loading, errored, or flag-off read has no verdict,
    // and the hero is the most prominent place a false green could appear.
    for (const status of ["loading", "error", "disabled"] as const) {
      for (const runStatus of ["completed", "running", "cancelled"]) {
        const view = buildRunVerdictHero(
          input({
            run: { ...RUN, status: runStatus } as EvalSuiteRun,
            decision: { status, summary: null, diagnostics: [] },
          }),
        );
        expect(view.verdict.word, `${status}/${runStatus}`).not.toMatch(
          PASS_WORDS,
        );
        expect(view.verdict.tone, `${status}/${runStatus}`).not.toBe("passed");
        expect(view.sentence.text, `${status}/${runStatus}`).not.toMatch(
          PASS_WORDS,
        );
      }
    }
  });

  it("explains a no-verdict run and stays silent on a decided one", () => {
    const undecided = buildRunVerdictHero(
      input({
        decision: {
          status: "ready",
          summary: summary({
            verdict: "notEstablished",
            undecided: { reason: "runNotTerminal" },
          }),
          diagnostics: [],
        },
      }),
    );
    expect(undecided.verdict.undecidedLine).toBe(
      "the run has not finished yet",
    );

    // A caveat beside a decision reads as a caveat ON the decision.
    const decided = buildRunVerdictHero(input());
    expect(decided.verdict.undecidedLine).toBeNull();
  });
});

describe("choosing what to lead with", () => {
  it("takes the contract's first failed stage", () => {
    const focus = selectHeroFocus([diagnostic()]);
    expect(focus?.selectedBy).toBe("firstFailedStage");
    expect(focus?.stage).toBe("selection");
    expect(focus?.reason).toBe("missingToolCall");
  });

  it("falls back to a reason row when no stage was established", () => {
    // The setup-abort shape: every stage reads not measured, so there is no
    // failed stage to open, and the one sentence explaining the trial would
    // otherwise be hidden.
    const aborted = diagnostic({
      chain: {
        status: "verified",
        stages: chainRows(
          {
            connection: "notMeasured",
            discovery: "notMeasured",
            selection: "notMeasured",
            call: "notMeasured",
            response: "notMeasured",
            userValue: "notMeasured",
          },
          { connection: "setupAborted" },
        ),
        stageAnalyzerVersion: 8,
      },
    });
    const focus = selectHeroFocus([aborted]);
    expect(focus?.selectedBy).toBe("firstWithReason");
    // A quoted row is not a break location. Claiming one here would assert a
    // failure the contract declined to establish.
    expect(focus?.stage).toBeNull();
    expect(focus?.reason).toBe("setupAborted");
  });

  it("still names a case when every chain is withheld", () => {
    const withheld = diagnostic({
      chain: { status: "unverified", stageAnalyzerVersion: 8 },
    });
    const focus = selectHeroFocus([withheld]);
    expect(focus?.selectedBy).toBe("firstDiagnostic");
    expect(focus?.stage).toBeNull();
  });

  it("has nothing to lead with when there are no diagnostics", () => {
    expect(selectHeroFocus([])).toBeNull();
  });
});

describe("the one sentence", () => {
  it("names the case, the stage and the reason", () => {
    const view = buildRunVerdictHero(
      input({
        decision: {
          status: "ready",
          summary: summary(),
          diagnostics: [diagnostic()],
        },
      }),
    );
    expect(view.sentence.kind).toBe("brokeAt");
    expect(view.sentence.text).toBe(
      "Draw and share a diagram broke at Selection: an expected tool call was never made.",
    );
    expect(view.sentence).toMatchObject({
      expected: ["export_to_excalidraw"],
      observed: ["create_view"],
    });
  });

  it("never says root cause", () => {
    // A first failed stage is where the chain stopped. The word "cause" turns
    // a location into a claim about why, which is the mistake this whole
    // vocabulary exists to prevent.
    const view = buildRunVerdictHero(
      input({
        decision: {
          status: "ready",
          summary: summary(),
          diagnostics: [diagnostic()],
        },
      }),
    );
    expect(view.sentence.text.toLowerCase()).not.toContain("cause");
  });

  it("withholds a location when the chain did not validate", () => {
    const view = buildRunVerdictHero(
      input({
        decision: {
          status: "ready",
          summary: summary(),
          diagnostics: [
            diagnostic({
              chain: { status: "unverified", stageAnalyzerVersion: 8 },
            }),
          ],
        },
      }),
    );
    expect(view.sentence.kind).toBe("chainWithheld");
    expect(view.sentence.text).toContain("not established");
  });

  it("does not claim nothing failed on a failed run with no diagnostics", () => {
    // The page may hold none yet, or the run stopped before producing any.
    // "Nothing needs attention" beside the word "Failed" is a contradiction
    // the reader has to resolve, and they resolve it by distrusting both.
    const view = buildRunVerdictHero(input());
    expect(view.sentence.text).toBe(
      "No non-passing iteration was returned for this run.",
    );
  });
});

describe("the numbers beside it", () => {
  it("counts cases on a policy-v2 run", () => {
    const view = buildRunVerdictHero(
      input({
        decision: {
          status: "ready",
          summary: summary({
            verdictSource: "policyV2",
            counts: {
              measurementUnit: "caseVariant",
              total: 3,
              passed: 2,
              failed: 1,
              inconclusive: 0,
            },
          }),
          diagnostics: [],
        },
      }),
    );
    expect(view.stats.cases).toEqual({
      kind: "cases",
      passed: 2,
      total: 3,
      inconclusive: 0,
    });
  });

  it("keeps a legacy run's trials labelled as trials", () => {
    // "2 of 3" means two different things on the two verdict sources, and a
    // reader who takes a legacy trial count for a case count has been told
    // something false by a number that looked identical.
    const view = buildRunVerdictHero(input());
    expect(view.stats.cases).toEqual({ kind: "trials", passed: 2, total: 3 });
  });

  it("keeps an unrecorded legacy total absent rather than zero", () => {
    const view = buildRunVerdictHero(
      input({
        decision: {
          status: "ready",
          summary: summary({ counts: { measurementUnit: "trial" } }),
          diagnostics: [],
        },
      }),
    );
    expect(view.stats.cases).toEqual({
      kind: "trials",
      passed: null,
      total: null,
    });
  });

  it("reports no counts at all when the decision is unavailable", () => {
    const view = buildRunVerdictHero(
      input({ decision: { status: "error", summary: null, diagnostics: [] } }),
    );
    expect(view.stats.cases).toEqual({ kind: "unavailable" });
    // Iteration totals still come from rows this page holds, which is a
    // different and honestly-labelled population.
    expect(view.stats.iterations).toEqual({ passed: 1, total: 1 });
  });

  it("sums tokens and tool calls, and leaves them absent when unrecorded", () => {
    const withData = buildRunVerdictHero(
      input({ iterations: [iteration(), iteration({ tokensUsed: 500 })] }),
    );
    expect(withData.stats.tokens).toBe(1500);
    expect(withData.stats.toolCalls).toBe(2);

    const noData = buildRunVerdictHero(
      input({
        iterations: [
          {
            _id: "it_x",
            status: "completed",
            result: "passed",
          } as unknown as EvalIteration,
        ],
      }),
    );
    expect(noData.stats.tokens).toBeNull();
    expect(noData.stats.toolCalls).toBeNull();
  });
});
