/**
 * The presentation model's honest-state rules.
 *
 * Every assertion here is about a number NOT being invented: a zero denominator
 * rendering as words rather than `0%`, a genuine measured zero still rendering
 * as `0%`, an absent latency aggregate staying absent rather than becoming
 * `0 ms`, and the unlabelled intent slice surviving as a real population.
 */
import { describe, expect, it } from "vitest";
import {
  GOLDEN_STAGE_ANALYTICS,
  stageAnalyticsVariation,
} from "@/test/stage-analytics-fixtures";
import {
  NOT_MEASURED_LABEL,
  describeExclusions,
  deriveStageAnalyticsPanelState,
  excludedDetailSummary,
  formatLatency,
  overallSlice,
  sliceTitle,
  slicesOfDimension,
  toRunHeaderView,
  toSetupView,
  toSliceView,
  toStageRowView,
} from "../stage-analytics-model";
import {
  FAILURE_CATEGORY_LABELS,
  STAGE_REASON_LABELS,
  type EvalStageTally,
} from "@mcpjam/sdk/contract";

function tally(overrides: Partial<EvalStageTally> = {}): EvalStageTally {
  return {
    stage: "selection",
    applicable: 0,
    reached: 0,
    notReached: 0,
    reachUnknown: 0,
    measured: 0,
    passed: 0,
    failed: 0,
    notMeasured: 0,
    notApplicable: 0,
    excluded: {},
    reasons: [],
    ...overrides,
  } as EvalStageTally;
}

describe("panel state derivation", () => {
  const base = {
    rows: [],
    error: null,
    runCount: 0,
    runsLoading: false,
  } as const;

  it("treats a service failure as unsupported, not as empty", () => {
    const state = deriveStageAnalyticsPanelState({
      ...base,
      status: "error",
      error: { message: "upstream is down", kind: "requestFailed" },
    });
    expect(state.kind).toBe("unsupported");
  });

  it("treats a missing route as unsupported", () => {
    const state = deriveStageAnalyticsPanelState({
      ...base,
      status: "error",
      error: { message: "not served here", kind: "routeUnavailable" },
    });
    expect(state.kind).toBe("unsupported");
  });

  it("treats a contract failure as an error, not as unsupported", () => {
    // A payload that did not validate is a BUG REPORT, not a deployment gap.
    const state = deriveStageAnalyticsPanelState({
      ...base,
      status: "error",
      error: { message: "did not match the contract", kind: "invalidContract" },
    });
    expect(state.kind).toBe("error");
  });

  it("renders a vanished suite as an error, never as empty analytics", () => {
    const state = deriveStageAnalyticsPanelState({
      ...base,
      status: "error",
      error: { message: "Eval suite not found", kind: "notFound" },
    });
    expect(state.kind).toBe("error");
  });

  it("distinguishes pre-analytics runs from a suite with no runs", () => {
    const legacy = deriveStageAnalyticsPanelState({
      ...base,
      status: "ready",
      runCount: 12,
    });
    expect(legacy).toEqual({ kind: "unmeasuredLegacy", runCount: 12 });

    const empty = deriveStageAnalyticsPanelState({ ...base, status: "ready" });
    expect(empty).toEqual({ kind: "empty" });
  });

  it("holds the loading frame while the run list is still arriving", () => {
    // Guessing here would flash "no runs yet" at a suite that has hundreds.
    const state = deriveStageAnalyticsPanelState({
      ...base,
      status: "ready",
      runsLoading: true,
    });
    expect(state.kind).toBe("loading");
  });

  it("is ready when documents arrived", () => {
    const state = deriveStageAnalyticsPanelState({
      ...base,
      status: "ready",
      rows: [GOLDEN_STAGE_ANALYTICS],
    });
    expect(state.kind).toBe("ready");
  });
});

describe("rate formatting", () => {
  it("renders words, not a zero, when there is nothing to divide", () => {
    const view = toStageRowView(tally());
    expect(view.pass.percent).toBeNull();
    expect(view.pass.arithmetic).toBeNull();
    // No bar either — a zero-width bar still reads as a measured zero.
    expect(view.pass.fraction).toBeNull();
    expect(NOT_MEASURED_LABEL).toBe("not measured");
  });

  it("renders a GENUINE measured zero as 0%", () => {
    // 0 of 5 eligible is a real finding and must not be hidden behind words.
    const view = toStageRowView(
      tally({ applicable: 5, reached: 5, measured: 5, passed: 0, failed: 5 }),
    );
    expect(view.pass.percent).toBe("0%");
    expect(view.pass.arithmetic).toBe("0/5");
    expect(view.pass.fraction).toBe(0);
  });

  it("keeps the arithmetic beside every rate", () => {
    const view = toStageRowView(
      tally({
        applicable: 5,
        reached: 4,
        notReached: 1,
        measured: 4,
        passed: 3,
        failed: 1,
      }),
    );
    expect(view.pass.percent).toBe("75%");
    expect(view.pass.arithmetic).toBe("3/4");
    expect(view.coverage.arithmetic).toBe("4/4");
    expect(view.reach.arithmetic).toBe("4/5");
  });

  it("excludes reachUnknown from the reach denominator", () => {
    // A trial we captured nothing for is not evidence of a drop-off; counting
    // it would make broken instrumentation look like a broken server.
    const view = toStageRowView(
      tally({
        applicable: 5,
        reached: 3,
        notReached: 1,
        reachUnknown: 1,
        measured: 3,
        passed: 3,
      }),
    );
    expect(view.reach.arithmetic).toBe("3/4");
    expect(view.reach.exclusions.join(" ")).toContain("reach is undecidable");
  });
});

describe("exclusion naming", () => {
  it("names each class and omits the ones that excluded nothing", () => {
    expect(describeExclusions({ lifecycle: 2, integrity: 1 })).toEqual([
      "2 never produced a comparable observation",
      "1 evidence missing or unverified",
    ]);
    expect(describeExclusions({})).toEqual([]);
    // Zero is omitted by the contract; an explicit 0 means the same as absent.
    expect(describeExclusions({ lifecycle: 0 })).toEqual([]);
  });
});

describe("latency", () => {
  it("is absent, not zero, when there are no samples", () => {
    expect(formatLatency(undefined)).toBeNull();
  });

  it("always carries the unit and the basis", () => {
    expect(
      formatLatency({
        unit: "ms",
        basis: "evidence_span_union",
        sampleCount: 4,
        totalMs: 400,
      }),
    ).toBe("100 ms · evidence span union");
    expect(
      formatLatency({
        unit: "ms",
        basis: "setup_phase_wall",
        sampleCount: 2,
        totalMs: 500,
      }),
    ).toBe("250 ms · setup wall clock");
  });
});

describe("slices", () => {
  it("names the unlabelled intent slice rather than dropping it", () => {
    expect(sliceTitle({ dimension: "intent", intent: null })).toBe("Unlabeled");
    expect(sliceTitle({ dimension: "intent", intent: "search" })).toBe(
      "search",
    );
  });

  it("keeps every intent slice from the golden document, including the null one", () => {
    const intents = slicesOfDimension(GOLDEN_STAGE_ANALYTICS, "intent");
    expect(intents.map((slice) => slice.title)).toContain("Unlabeled");
    expect(intents.map((slice) => slice.title)).toContain("search");
  });

  it("carries the provider beside a model, and never invents an engine", () => {
    const models = slicesOfDimension(GOLDEN_STAGE_ANALYTICS, "model");
    expect(models[0]?.subtitle).toBeTruthy();
    expect(sliceTitle({ dimension: "host", hostKey: "host_x" })).toBe("host_x");
  });

  it("finds exactly one overall slice and keeps the six stages in order", () => {
    const overall = overallSlice(GOLDEN_STAGE_ANALYTICS);
    expect(overall).not.toBeNull();
    expect(overall!.stages.map((stage) => stage.stage)).toEqual([
      "connection",
      "discovery",
      "selection",
      "call",
      "response",
      "userValue",
    ]);
  });
});

describe("run header", () => {
  it("flags a provisional document", () => {
    const header = toRunHeaderView(GOLDEN_STAGE_ANALYTICS);
    expect(header.provisional).toBe(true);
    expect(header.materializationLabel).toContain("may change");
  });

  it("names the population on the trial count", () => {
    const header = toRunHeaderView(GOLDEN_STAGE_ANALYTICS);
    // Never "cases" — the unit is a trial and the count says so.
    expect(header.populationLabel).toContain("trials in this run");
    expect(header.populationLabel).not.toContain("case");
  });

  it("discloses mixed analyzer versions", () => {
    const header = toRunHeaderView(
      stageAnalyticsVariation({ sourceStageAnalyzerVersions: [1, 2] }),
    );
    expect(header.disclosures.join(" ")).toContain("Mixed stage analyzer");
  });

  it("discloses truncation rather than presenting a partial set as complete", () => {
    const header = toRunHeaderView(
      stageAnalyticsVariation({
        sliceTruncation: [
          { dimension: "model", distinctValues: 40, retained: 25 },
        ],
      }),
    );
    expect(header.disclosures.join(" ")).toContain("not the complete set");
  });

  it("reports a final document as final", () => {
    const header = toRunHeaderView(
      stageAnalyticsVariation({ materializationState: "final" }),
    );
    expect(header.provisional).toBe(false);
  });
});

describe("setup", () => {
  it("keeps impacted trials separate from attempts", () => {
    const setup = GOLDEN_STAGE_ANALYTICS.setup.map(toSetupView);
    expect(setup[0]?.label).toBe("Connection");
    // The asymmetry is the point: one attempt can block many trials.
    expect(typeof setup[0]?.impactedTrials).toBe("number");
    expect(typeof setup[0]?.uniqueAttempts).toBe("number");
  });
});

describe("human words, never a wire enum", () => {
  it("labels a stage reason from the contract's own map", () => {
    const view = toStageRowView(
      tally({
        applicable: 3,
        reached: 3,
        measured: 0,
        notMeasured: 3,
        reasons: [{ reason: "noEvidenceCaptured", count: 3 }],
      }),
    );
    expect(view.reasons).toEqual([
      {
        reason: "noEvidenceCaptured",
        label: STAGE_REASON_LABELS.noEvidenceCaptured,
        count: 3,
      },
    ]);
    // The wire spelling SURVIVES beside the words — it is what a `data-`
    // attribute and a later join match on — but it is never the label.
    expect(view.reasons[0]!.label).not.toBe("noEvidenceCaptured");
  });

  it("labels a failure category from the contract's own map", () => {
    const overall = overallSlice(GOLDEN_STAGE_ANALYTICS)!;
    const view = toSliceView(overall, 0);
    expect(view.failureCategories[0]).toEqual({
      category: "selection",
      label: FAILURE_CATEGORY_LABELS.selection,
      count: 1,
    });
  });

  it("regression: no raw enum reaches a label, anywhere in the golden document", () => {
    // The bug this whole pass exists to kill: `noEvidenceCaptured (3)` and
    // `serverData (4)` printed at a human. A camelCase identifier in a LABEL
    // is the shape of that bug, whatever the specific enum member is.
    const camelCase = /[a-z][A-Z]/;
    for (const [index, row] of GOLDEN_STAGE_ANALYTICS.slices.entries()) {
      const view = toSliceView(row, index);
      for (const category of view.failureCategories) {
        expect(category.label).not.toMatch(camelCase);
      }
      for (const stage of view.stages) {
        for (const reason of stage.reasons) {
          expect(reason.label).not.toMatch(camelCase);
        }
      }
    }
  });
});

describe("the fine-grained exclusion detail", () => {
  it("renders each reason in words, omitting the ones that excluded nothing", () => {
    const header = toRunHeaderView(GOLDEN_STAGE_ANALYTICS);
    // The golden document carries exactly three of the fourteen keys.
    expect(header.excludedDetail.map((entry) => entry.key).sort()).toEqual([
      "cancelled",
      "chainUnverified",
      "chainVersionAhead",
    ]);
    for (const entry of header.excludedDetail) {
      expect(entry.label).not.toMatch(/[a-z][A-Z]/);
      expect(entry.count).toBeGreaterThan(0);
    }
  });

  it("is empty when nothing was excluded, so the disclosure can be absent", () => {
    const header = toRunHeaderView(
      stageAnalyticsVariation({
        excludedTrialDetail: {},
        excludedTrials: {},
        includedTrials: 4,
        totalTrials: 4,
      }),
    );
    expect(header.excludedDetail).toEqual([]);
  });

  it("names the population before the reasons", () => {
    const header = toRunHeaderView(GOLDEN_STAGE_ANALYTICS);
    // 3 of 7 excluded. A list of reasons with no denominator lets a reader
    // take three excluded trials out of seven for three out of three hundred.
    expect(excludedDetailSummary(header)).toContain("3 of 7 trials excluded");
  });
});
