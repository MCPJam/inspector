/**
 * The join between D5c's tallies and D9's diagnostics.
 *
 * The assertions here are mostly about NOT attributing: a diagnostic reaches a
 * stage because its own verified chain says that stage failed, and a
 * diagnostic with no failed stage row reaches no stage at all. The two
 * population traps at the bottom are the ones a reader would otherwise get
 * wrong in opposite directions.
 */
import { describe, expect, it } from "vitest";
import {
  STAGE_REASON_LABELS,
  type EvalRunDecisionDiagnostic,
  type EvalRunDecisionSummary,
  type EvalStageAnalyticsV1,
  type EvalStageTally,
  type StageReason,
  type UserValueStage,
} from "@mcpjam/sdk/contract";
import {
  GOLDEN_STAGE_ANALYTICS,
  stageAnalyticsVariation,
} from "@/test/stage-analytics-fixtures";
import { readDecisionSummaryFixture } from "@/test/eval-decision-summary-fixtures";
import {
  buildStageFindings,
  STAGE_REASON_NOT_RECORDED_LABEL,
} from "../stage-findings-model";

const SUMMARY = readDecisionSummaryFixture("measured-failure-at-every-stage");

/**
 * The golden analytics document, retitled onto the decision corpus's run.
 *
 * Overrides replace the OVERALL slice's tally wholesale rather than patching
 * fields into it, and the result is re-validated by the refined schema — so a
 * fixture can never assert against counts the contract would have rejected
 * (`applicable = reached + notReached + reachUnknown` and friends).
 */
function analyticsFor(
  stageOverrides: Partial<Record<UserValueStage, EvalStageTally>> = {},
): EvalStageAnalyticsV1 {
  const draft = structuredClone(GOLDEN_STAGE_ANALYTICS);
  draft.runId = SUMMARY.runId;
  const overall = draft.slices.find(
    (slice) => slice.slice.dimension === "overall",
  )!;
  overall.stages = overall.stages.map(
    (stage) => stageOverrides[stage.stage] ?? stage,
  );
  return stageAnalyticsVariation(draft);
}

/** A complete, self-consistent tally for one stage. */
function stageTally(
  stage: UserValueStage,
  counts: { measured: number; passed: number; failed: number },
): EvalStageTally {
  return {
    stage,
    applicable: counts.measured,
    reached: counts.measured,
    notReached: 0,
    reachUnknown: 0,
    measured: counts.measured,
    passed: counts.passed,
    failed: counts.failed,
    notMeasured: 0,
    notApplicable: 0,
    excluded: {},
    reasons: [],
  } as EvalStageTally;
}

function build(
  overrides: Partial<Parameters<typeof buildStageFindings>[0]> = {},
) {
  return buildStageFindings({
    analytics: analyticsFor(),
    summary: SUMMARY,
    diagnostics: SUMMARY.diagnostics.items,
    scannedIterations: SUMMARY.diagnostics.scannedIterations,
    serverComplete: SUMMARY.diagnostics.complete,
    walkExhausted: true,
    status: "ready",
    error: null,
    runTerminal: true,
    canViewTrace: true,
    ...overrides,
  });
}

function ready(state: ReturnType<typeof buildStageFindings>) {
  if (state.kind !== "ready")
    throw new Error(`expected ready, got ${state.kind}`);
  return state;
}

/**
 * Every trial attributed to any stage.
 *
 * NOT `Object.keys(byStage)`: a stage whose tally counted failures and whose
 * diagnostics explain none of them still gets a section, because that gap is
 * itself the finding. What "never attributed" means is that no stage's GROUPS
 * carry the trial.
 */
function attributedTrials(state: { byStage: Record<string, unknown> }) {
  return Object.values(
    state.byStage as Record<
      string,
      { groups: { trials: unknown[] }[] } | undefined
    >,
  ).flatMap((findings) =>
    (findings?.groups ?? []).flatMap((group) => group.trials),
  );
}

describe("attribution", () => {
  it("attaches a diagnostic to the stage its own chain marks failed", () => {
    const state = ready(build());
    // The corpus has one trial failing at each of the six stages.
    for (const stage of [
      "connection",
      "discovery",
      "selection",
      "call",
      "response",
      "userValue",
    ] as UserValueStage[]) {
      const findings = state.byStage[stage];
      expect(findings, stage).toBeTruthy();
      expect(
        findings!.groups.flatMap((group) => group.trials).length,
        stage,
      ).toBeGreaterThan(0);
    }
  });

  it("marks a NON-PRIMARY appearance rather than reporting it as the origin", () => {
    // A trial whose chain failed at selection AND again at userValue shows
    // under both; the later row says an earlier stage also failed, because a
    // reader who takes it for the origin goes after the wrong link.
    const diagnostic = withStages("it-x", [
      ["connection", "passed"],
      ["discovery", "passed"],
      ["selection", "failed", "missingToolCall"],
      ["call", "failed", "protocolError"],
      ["response", "passed"],
      ["userValue", "passed"],
    ]);
    const state = ready(build({ diagnostics: [diagnostic] }));
    const atSelection = state.byStage.selection!.groups[0]!.trials[0]!;
    const atCall = state.byStage.call!.groups[0]!.trials[0]!;
    expect(atSelection.earlierStageAlsoFailed).toBe(false);
    expect(atCall.earlierStageAlsoFailed).toBe(true);
  });

  it("sends a diagnostic with no failed stage row to the RUN-LEVEL bucket", () => {
    // A setup abort and an evaluator error are real answers about a run that
    // never reached a stage. Guessing one onto a stage would put a trial's
    // error text under something nothing measured it at.
    const setupAbort = withStages("it-setup", [
      ["connection", "notMeasured", "setupAborted"],
      ["discovery", "notMeasured", "setupAborted"],
      ["selection", "notMeasured", "setupAborted"],
      ["call", "notMeasured", "setupAborted"],
      ["response", "notMeasured", "setupAborted"],
      ["userValue", "notMeasured", "setupAborted"],
    ]);
    const state = ready(build({ diagnostics: [setupAbort] }));
    expect(attributedTrials(state)).toHaveLength(0);
    expect(state.runLevel?.count).toBe(1);
    expect(state.runLevel?.line).toContain("not attributable to a stage");
  });

  it("never attributes an UNVERIFIED chain", () => {
    // A derivation that was offered and rejected is not evidence, so the rows
    // it would have supplied are withheld rather than half-believed.
    const unverified = {
      ...withStages("it-u", [["connection", "failed", "connectFailed"]]),
      chain: { status: "unverified" as const, analyzerVersion: 4 },
    } as EvalRunDecisionDiagnostic;
    const state = ready(build({ diagnostics: [unverified] }));
    expect(attributedTrials(state)).toHaveLength(0);
    expect(state.runLevel?.count).toBe(1);
  });

  it("never attributes an ABSENT chain", () => {
    const absent = {
      ...withStages("it-a", [["connection", "failed", "connectFailed"]]),
      chain: { status: "absent" as const },
    } as EvalRunDecisionDiagnostic;
    const state = ready(build({ diagnostics: [absent] }));
    expect(attributedTrials(state)).toHaveLength(0);
    expect(state.runLevel?.count).toBe(1);
  });
});

describe("grouping and caps", () => {
  const many = Array.from({ length: 9 }, (_, index) =>
    withStages(`it-${index}`, [
      ["connection", "passed"],
      ["discovery", "passed"],
      [
        "selection",
        "failed",
        // 5 missing, 3 unexpected, 1 argument — three groups, uneven.
        index < 5
          ? "missingToolCall"
          : index < 8
            ? "unexpectedToolCall"
            : "argumentMismatch",
      ],
      ["call", "notReached", "earlierStageFailed"],
      ["response", "notReached", "earlierStageFailed"],
      ["userValue", "notReached", "earlierStageFailed"],
    ]),
  );

  it("groups by the stage row's own reason — the tally's vocabulary", () => {
    const state = ready(build({ diagnostics: many }));
    const groups = state.byStage.selection!.groups;
    expect(groups.map((group) => group.reason)).toEqual([
      "missingToolCall",
      "unexpectedToolCall",
      "argumentMismatch",
    ]);
    expect(groups.map((group) => group.count)).toEqual([5, 3, 1]);
    expect(groups[0]!.label).toBe(STAGE_REASON_LABELS.missingToolCall);
  });

  it("orders count-descending, tie-broken by STAGE_REASONS order", () => {
    const tied = [
      withStages("a", [["selection", "failed", "argumentMismatch"]]),
      withStages("b", [["selection", "failed", "missingToolCall"]]),
    ];
    const groups = ready(build({ diagnostics: tied })).byStage.selection!
      .groups;
    // `missingToolCall` precedes `argumentMismatch` in STAGE_REASONS.
    expect(groups.map((group) => group.reason)).toEqual([
      "missingToolCall",
      "argumentMismatch",
    ]);
  });

  it("keeps every trial in the model — the CAPS are the view's business", () => {
    // Capping in the model would make the count and the list disagree, and the
    // count is the thing a reader checks against the tally.
    const state = ready(build({ diagnostics: many }));
    const first = state.byStage.selection!.groups[0]!;
    expect(first.count).toBe(5);
    expect(first.trials).toHaveLength(5);
  });

  it("NEVER invents a reason for a failed row that recorded none", () => {
    // `stageResultRowSchema` makes `reason` optional, so a verified `failed`
    // row can legitimately carry none. An earlier draft substituted
    // `noEvidenceCaptured`, which states a specific cause the run never
    // recorded — under a label a reader would take as measured.
    const reasonless = withStages("it-noreason", [
      ["connection", "passed"],
      ["discovery", "passed"],
      ["selection", "failed"],
      ["call", "notReached", "earlierStageFailed"],
      ["response", "notReached", "earlierStageFailed"],
      ["userValue", "notReached", "earlierStageFailed"],
    ]);
    const group = ready(build({ diagnostics: [reasonless] })).byStage.selection!
      .groups[0]!;
    expect(group.reason).toBeNull();
    expect(group.key).toBe("reasonNotRecorded");
    expect(group.label).toBe(STAGE_REASON_NOT_RECORDED_LABEL);
    // The substituted reason's own words must not appear anywhere.
    expect(group.label).not.toBe(STAGE_REASON_LABELS.noEvidenceCaptured);
  });

  it("sorts the unexplained group LAST within its count, not first", () => {
    // With no reason there is nothing for a reader to act on, so it must not
    // outrank a group that names one. `STAGE_REASONS.indexOf(null)` is -1,
    // which sorted it ahead of every named reason.
    const mixed = [
      withStages("a", [["selection", "failed"]]),
      withStages("b", [["selection", "failed", "missingToolCall"]]),
    ];
    const groups = ready(build({ diagnostics: mixed })).byStage.selection!
      .groups;
    expect(groups.map((group) => group.key)).toEqual([
      "missingToolCall",
      "reasonNotRecorded",
    ]);
  });

  it("carries the diagnostics' own nextAction, and withholds a disputed one", () => {
    const state = ready(build({ diagnostics: many }));
    expect(state.byStage.selection!.groups[0]!.nextAction).toBe(
      "review tool selection and the tool catalog",
    );

    const disagreeing = [
      { ...many[0]!, nextAction: "review tool selection and the tool catalog" },
      {
        ...many[1]!,
        nextAction: "inspect the tool response returned by the server",
      },
    ];
    const groups = ready(build({ diagnostics: disagreeing })).byStage.selection!
      .groups;
    // Two categories under one reason is a real thing, and picking one of them
    // would be a guess wearing the contract's authority.
    expect(groups[0]!.nextAction).toBeNull();
  });
});

describe("evidence lines are composed only from carried fields", () => {
  it("carries the title, iteration number and observed failure", () => {
    const state = ready(build());
    const trial = state.byStage.connection!.groups[0]!.trials[0]!;
    expect(trial.title).toBe("Stops at the connection stage");
    expect(trial.iterationNumber).toBe(1);
    expect(trial.observedFailure).toBe("the connection stage did not hold");
  });

  it("carries tool names only where they ARE the finding", () => {
    const state = ready(build());
    // Selection and call: expected vs observed is what the reader compares.
    expect(
      state.byStage.selection!.groups[0]!.trials[0]!.expectedTools,
    ).toEqual(["fetch_order"]);
    // Connection: a tool name here is noise a reader has to rule out.
    expect(
      state.byStage.connection!.groups[0]!.trials[0]!.expectedTools,
    ).toBeNull();
    expect(
      state.byStage.connection!.groups[0]!.trials[0]!.observedTools,
    ).toBeNull();
  });

  it("gates the trace link on the same three conditions the decision card uses", () => {
    const state = ready(build());
    expect(state.byStage.connection!.groups[0]!.trials[0]!.traceable).toBe(
      true,
    );

    // No handler at all.
    const noHandler = ready(build({ canViewTrace: false }));
    expect(noHandler.byStage.connection!.groups[0]!.trials[0]!.traceable).toBe(
      false,
    );

    // Evidence naming a DIFFERENT run: a locator that would navigate somewhere
    // this view cannot answer for.
    const elsewhere = SUMMARY.diagnostics.items.map((item) => ({
      ...item,
      evidence: { ...item.evidence, runId: "some-other-run" },
    }));
    expect(
      ready(build({ diagnostics: elsewhere })).byStage.connection!.groups[0]!
        .trials[0]!.traceable,
    ).toBe(false);

    // No case id: the app focuses an iteration THROUGH its case, so there is
    // nowhere to send the reader.
    const caseless = SUMMARY.diagnostics.items.map((item) => {
      const copy = { ...item };
      delete (copy as { testCaseId?: string }).testCaseId;
      return copy;
    });
    expect(
      ready(build({ diagnostics: caseless })).byStage.connection!.groups[0]!
        .trials[0]!.traceable,
    ).toBe(false);
  });
});

describe("population honesty", () => {
  it("states the scope as complete when the SERVER said so", () => {
    const state = ready(build());
    expect(state.byStage.connection!.scopeLine).toContain(
      "over all 6 scanned trials",
    );
  });

  it("says a partial scan is partial", () => {
    const state = ready(
      build({
        serverComplete: false,
        walkExhausted: false,
        scannedIterations: 20,
      }),
    );
    expect(state.byStage.connection!.scopeLine).toContain(
      "over the first 20 trials scanned",
    );
    expect(state.byStage.connection!.scopeLine).toContain(
      "not the complete set",
    );
  });

  it("TRAP 1: names the stage failures on trials whose cases PASSED", () => {
    // D9 enumerates non-passing trials only; D5c tallies stage failures over
    // every included trial. Under policy v2 a case can pass with a failing
    // trial in it, so those failures have no diagnostic row — and silence here
    // would read as "we found nothing".
    const state = ready(
      build({
        analytics: analyticsFor({
          response: stageTally("response", {
            measured: 5,
            passed: 2,
            failed: 3,
          }),
        }),
      }),
    );
    // One `response` diagnostic in the corpus; the tally counts three.
    expect(state.byStage.response!.unattributedNote).toContain(
      "2 further stage failures occurred on trials whose cases passed",
    );
    expect(state.byStage.response!.unattributedNote).toContain(
      "no diagnostic row here",
    );
  });

  it("TRAP 1 is only claimed under a COMPLETE scan", () => {
    // On a partial page the gap is explained by the paging, and reporting it
    // as a population fact would invent a finding out of an unfinished read.
    const state = ready(
      build({
        serverComplete: false,
        analytics: analyticsFor({
          response: stageTally("response", {
            measured: 5,
            passed: 2,
            failed: 3,
          }),
        }),
      }),
    );
    expect(state.byStage.response!.unattributedNote).toBeNull();
  });

  it("TRAP 2: reports a disagreement rather than overwriting the tally", () => {
    // More attributed trials than the tally counted cannot be explained by
    // policy v2. The materializer counted the whole run and this counted a
    // page of it, so the disagreement is reported and both numbers stand.
    const state = ready(
      build({
        analytics: analyticsFor({
          connection: stageTally("connection", {
            measured: 6,
            passed: 6,
            failed: 0,
          }),
        }),
      }),
    );
    expect(state.byStage.connection!.reconciliationNote).toContain(
      "worth reporting",
    );
    // The TALLY is what the headline still states.
    expect(state.byStage.connection!.headline).toContain(
      "failed in 0 of 6 measured trials",
    );
  });

  it("never says '0 findings' where a stage measured nothing", () => {
    const state = ready(
      build({
        diagnostics: [],
        analytics: analyticsFor({
          userValue: stageTally("userValue", {
            measured: 0,
            passed: 0,
            failed: 0,
          }),
        }),
      }),
    );
    // No section at all, rather than a section reporting a zero.
    expect(state.byStage.userValue).toBeUndefined();
  });
});

describe("degraded states are each their own variant", () => {
  const base = { analytics: analyticsFor(), summary: SUMMARY };

  it("disabled renders nothing and asks nothing", () => {
    expect(build({ ...base, status: "disabled" }).kind).toBe("disabled");
  });

  it("a non-terminal run has nothing decided to have diagnostics about", () => {
    expect(build({ ...base, runTerminal: false }).kind).toBe("runNotTerminal");
  });

  it("loading is loading, not empty", () => {
    expect(build({ ...base, status: "loading" }).kind).toBe("loading");
  });

  it("an unreadable page says so, and never as a finding about the server", () => {
    const state = build({
      ...base,
      status: "error",
      error: {
        title: "Couldn't load the trial evidence",
        detail: "It failed.",
      },
    });
    if (state.kind !== "unavailable") throw new Error("expected unavailable");
    expect(state.title).toContain("Couldn't load");
    expect(state.detail).not.toMatch(/fail(ed|ure) (of|in) the server/i);
  });

  it("a legacy run has no diagnostics contract, which is not 'no failures'", () => {
    const legacy = readDecisionSummaryFixture("legacy-run-without-counts");
    const state = build({
      summary: legacy,
      analytics: analyticsFor(),
      diagnostics: [],
    });
    expect(state.kind).toBe("noDecisionDiagnostics");
  });

  it("two documents about different runs render as NOTHING, not as an error", () => {
    // This is what a mid-navigation frame looks like, and an alarm for a state
    // that resolves itself would train a reader to ignore it.
    const state = build({
      analytics: stageAnalyticsVariation({ runId: "a-different-run" }),
    });
    expect(state.kind).toBe("identityMismatch");
  });

  it("a provisional document inherits ONE caveat line", () => {
    const state = ready(build());
    expect(state.provisionalNote).toContain("provisional");
  });

  it("never states a verdict", () => {
    const state = ready(build());
    const text = JSON.stringify(state);
    expect(text).not.toContain("inconclusive");
    expect(text).not.toContain("notEstablished");
    expect(text.toLowerCase()).not.toContain("root cause");
  });
});

/** A diagnostic whose verified chain carries exactly the rows given. */
function withStages(
  iterationId: string,
  rows: [UserValueStage, string, StageReason?][],
): EvalRunDecisionDiagnostic {
  return {
    iterationId,
    iterationNumber: 1,
    testCaseId: `row-${iterationId}`,
    title: `case ${iterationId}`,
    status: "completed",
    result: "failed",
    chain: {
      status: "verified",
      stages: rows.map(([stage, state, reason]) => ({
        stage,
        state,
        ...(reason ? { reason } : {}),
      })),
      ...(rows.find((row) => row[1] === "failed")
        ? { firstFailedStage: rows.find((row) => row[1] === "failed")![0] }
        : {}),
      analyzerVersion: 4,
    },
    expected: { toolNames: ["fetch_order"] },
    observed: { toolNames: ["other_tool"], failure: "it did not hold" },
    evidence: {
      runId: SUMMARY.runId,
      iterationId,
      tracePath: `/trace/${iterationId}`,
    },
    nextAction: "review tool selection and the tool catalog",
  } as EvalRunDecisionDiagnostic;
}
