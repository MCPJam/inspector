/**
 * `EvalStageAnalyticsV1` and its reference aggregation.
 *
 * The suite is organized around the ways a funnel LIES:
 *
 *   - a zero denominator rendered as a number;
 *   - an excluded trial that leaked into a denominator;
 *   - a payload we could not read, counted as a passing observation;
 *   - one copied setup signal counted once per iteration;
 *   - a truncated slice array that reads as "these are all the models";
 *   - and two incomparable runs drawn side by side as a comparison.
 *
 * Plus the golden fixture, which is the conformance target the backend's
 * hand-written materializer is checked against — the two implementations may
 * differ, their semantics may not.
 */

import { describe, expect, test } from "vitest";
import {
  STAGE_ANALYZER_VERSION,
  USER_VALUE_STAGES,
  aggregateStageAnalytics,
  classifyStageAnalyticsTrial,
  deriveStageMeasurements,
  evalStageAnalyticsSchema,
  isServerAttributedSetupFailure,
  latencyMeanMs,
  measuredPassRate,
  measurementCoverageRate,
  reachRate,
  stageAnalyticsParityBlockers,
  stageRate,
  type EvalStageAnalyticsV1,
  type StageAnalyticsTrialInput,
  type StageResultRow,
  type UserValueStage,
} from "../src/contract/index.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

const chainOf = (
  states: Partial<Record<UserValueStage, StageResultRow["state"]>>,
  reasons: Partial<Record<UserValueStage, StageResultRow["reason"]>> = {}
): StageResultRow[] =>
  USER_VALUE_STAGES.map((stage) => ({
    stage,
    state: states[stage] ?? "passed",
    ...(reasons[stage] ? { reason: reasons[stage] } : {}),
  }));

/** A well-formed, believed trial. Overrides narrow it. */
const trial = (
  over: Partial<StageAnalyticsTrialInput> = {}
): StageAnalyticsTrialInput => {
  const stageResults = over.stageResults ?? chainOf({});
  return {
    trialKey: "i1",
    status: "completed",
    stageResults,
    stageAnalyzerVersion: STAGE_ANALYZER_VERSION,
    chainVerified: true,
    measurements: deriveStageMeasurements({ stageResults }),
    measurementsVerified: true,
    ...over,
  };
};

const run = (over: Record<string, unknown> = {}) => ({
  runId: "run_1",
  suiteId: "suite_1",
  materializationState: "final" as const,
  now: 1_700_000_000_000,
  readerStageAnalyzerVersion: STAGE_ANALYZER_VERSION,
  ...over,
});

const aggregate = (
  trials: StageAnalyticsTrialInput[],
  runOver: Record<string, unknown> = {},
  setupSignals?: Parameters<typeof aggregateStageAnalytics>[0]["setupSignals"]
) => aggregateStageAnalytics({ run: run(runOver), trials, setupSignals });

const overallOf = (row: EvalStageAnalyticsV1) =>
  row.slices.find((s) => s.slice.dimension === "overall")!;

const stageOf = (row: EvalStageAnalyticsV1, stage: UserValueStage) =>
  overallOf(row).stages[USER_VALUE_STAGES.indexOf(stage)]!;

// ── rates ────────────────────────────────────────────────────────────────────

describe("stageRate — 0/0 is never a number", () => {
  test("a zero denominator is notMeasured, with a null value", () => {
    expect(stageRate(0, 0)).toMatchObject({
      state: "notMeasured",
      value: null,
      numerator: 0,
      denominator: 0,
    });
  });

  test("value is the exact quotient", () => {
    expect(stageRate(1, 4)).toMatchObject({ state: "measured", value: 0.25 });
  });

  test("an impossible rate is refused rather than shipped", () => {
    // A number above 1 is not something anyone can act on.
    expect(stageRate(5, 4).state).toBe("notMeasured");
    expect(stageRate(-1, 4).state).toBe("notMeasured");
  });

  test("every rate carries its arithmetic and its exclusions", () => {
    const row = aggregate([trial()]);
    for (const rate of [
      measurementCoverageRate(stageOf(row, "call")),
      measuredPassRate(stageOf(row, "call")),
      reachRate(stageOf(row, "call")),
    ]) {
      expect(rate).toHaveProperty("numerator");
      expect(rate).toHaveProperty("denominator");
      expect(rate).toHaveProperty("exclusions");
      expect(rate).toHaveProperty("state");
    }
  });

  test("a run with nothing includable reports notMeasured, not zero", () => {
    const row = aggregate([trial({ status: "cancelled" })]);
    expect(row.includedTrials).toBe(0);
    expect(measuredPassRate(stageOf(row, "call")).state).toBe("notMeasured");
    expect(reachRate(stageOf(row, "call")).state).toBe("notMeasured");
  });

  test("a run with NO TRIALS AT ALL still produces a valid row", () => {
    // A run cancelled before its first iteration existed, or one whose every
    // case was filtered or disabled. Ordinary outcomes, not error states.
    //
    // The `overall` slice must be present even here: it is the one slice every
    // reader is promised and the schema requires exactly one. Built lazily by
    // the first trial, a zero-trial run emitted `slices: []` and a row that
    // failed this contract's own validator — turning an honest "nothing to
    // measure" into an integrity failure at the write boundary.
    const row = aggregate([]);
    const parsed = evalStageAnalyticsSchema.safeParse(row);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);

    const overall = overallOf(row);
    expect(overall.includedTrials).toBe(0);
    expect(row.totalTrials).toBe(0);
    expect(row.slices).toHaveLength(1);
    // No dimension values were observed, so none are invented — an "unknown
    // model" row would invite a comparison against it.
    expect(row.slices.map((s) => s.slice.dimension)).toEqual(["overall"]);

    // Zero everywhere, and every rate notMeasured rather than 0.
    for (const stage of USER_VALUE_STAGES) {
      const tally = stageOf(row, stage);
      expect(tally).toMatchObject({ applicable: 0, reached: 0, measured: 0 });
      expect(measurementCoverageRate(tally).state).toBe("notMeasured");
      expect(measuredPassRate(tally).state).toBe("notMeasured");
      expect(reachRate(tally).state).toBe("notMeasured");
    }
  });
});

describe("the three formulas", () => {
  test("reach rate excludes unknown reach from its denominator", () => {
    // A trial we captured nothing for is not evidence of a drop-off. Counting
    // it as one would make broken instrumentation look like a broken server.
    const row = aggregate([
      trial({
        trialKey: "a",
        stageResults: chainOf({ response: "notReached" }),
      }),
      trial({
        trialKey: "b",
        stageResults: chainOf({ response: "notMeasured" }),
      }),
      trial({ trialKey: "c" }),
    ]);
    const response = stageOf(row, "response");
    expect(response).toMatchObject({
      applicable: 3,
      reached: 1,
      notReached: 1,
      reachUnknown: 1,
    });
    const rate = reachRate(response);
    expect(rate).toMatchObject({
      state: "measured",
      numerator: 1,
      denominator: 2,
    });
    expect(rate.exclusions.reachUnknown).toBe(1);
  });

  test("measurement coverage is measured / reached, and can be < 1", () => {
    // The `notMeasured`-but-reached trial is the whole point: it was there, we
    // just could not decide it.
    const reachedButUndecided = chainOf({ userValue: "notMeasured" });
    reachedButUndecided[5] = {
      stage: "userValue",
      state: "notMeasured",
      reason: "judgePending",
      evidence: { spanIds: ["s"] },
    };
    const row = aggregate([
      trial({ trialKey: "a" }),
      trial({
        trialKey: "b",
        stageResults: reachedButUndecided,
        measurements: deriveStageMeasurements({
          stageResults: reachedButUndecided,
          spans: [{ id: "s", startedAt: 0, endedAt: 5 }],
        }),
      }),
    ]);
    const userValue = stageOf(row, "userValue");
    expect(userValue).toMatchObject({
      reached: 2,
      measured: 1,
      notMeasured: 1,
    });
    expect(measurementCoverageRate(userValue)).toMatchObject({
      state: "measured",
      numerator: 1,
      denominator: 2,
      value: 0.5,
    });
  });

  test("measured pass rate divides by what was DECIDED", () => {
    const row = aggregate([
      trial({ trialKey: "a", stageResults: chainOf({ call: "failed" }) }),
      trial({ trialKey: "b" }),
    ]);
    expect(measuredPassRate(stageOf(row, "call"))).toMatchObject({
      numerator: 1,
      denominator: 2,
      value: 0.5,
    });
  });

  test("notApplicable is counted and kept out of `applicable`", () => {
    const row = aggregate([
      trial({ stageResults: chainOf({ userValue: "notApplicable" }) }),
    ]);
    const userValue = stageOf(row, "userValue");
    expect(userValue).toMatchObject({ applicable: 0, notApplicable: 1 });
    expect(userValue.excluded.notApplicable).toBe(1);
    expect(reachRate(userValue).state).toBe("notMeasured");
  });
});

// ── exclusions ───────────────────────────────────────────────────────────────

describe("exclusions — nothing unreadable is ever a passing observation", () => {
  test.each([
    ["pending", "lifecycle", "notTerminal"],
    ["running", "lifecycle", "notTerminal"],
    ["skipped", "lifecycle", "skipped"],
    ["cancelled", "lifecycle", "cancelled"],
    ["setup_failed", "lifecycle", "setupFailed"],
    ["timed_out", "lifecycle", "timedOut"],
  ])("%s is a lifecycle exclusion (%s/%s)", (status, cls, detail) => {
    const row = aggregate([trial({ status })]);
    expect(row.includedTrials).toBe(0);
    expect(row.excludedTrials[cls as "lifecycle"]).toBe(1);
    expect(row.excludedTrialDetail[detail as "notTerminal"]).toBe(1);
  });

  test("a missing chain is integrity/chainMissing", () => {
    const row = aggregate([trial({ stageResults: undefined })]);
    expect(row.excludedTrialDetail.chainMissing).toBe(1);
  });

  test("an UNVERIFIED chain is excluded — absent is not verified", () => {
    // A run from before the integrity check shipped carries no verdict, and
    // "we never checked" must not read as "it checked out".
    expect(
      aggregate([trial({ chainVerified: undefined })]).excludedTrialDetail
    ).toMatchObject({ chainUnverified: 1 });
    expect(
      aggregate([trial({ chainVerified: false })]).excludedTrialDetail
    ).toMatchObject({ chainUnverified: 1 });
  });

  test("a version-AHEAD chain is excluded as version, not as integrity", () => {
    // Expected during a deploy, and not a defect — so it must not pollute the
    // integrity tally that operators act on.
    const row = aggregate([
      trial({ stageAnalyzerVersion: STAGE_ANALYZER_VERSION + 1 }),
    ]);
    expect(row.excludedTrials.version).toBe(1);
    expect(row.excludedTrials.integrity).toBeUndefined();
    expect(row.excludedTrialDetail.chainVersionAhead).toBe(1);
  });

  test("missing or unbelieved measurements are excluded", () => {
    expect(
      aggregate([trial({ measurements: undefined })]).excludedTrialDetail
    ).toMatchObject({ measurementsMissing: 1 });
    expect(
      aggregate([trial({ measurementsVerified: false })]).excludedTrialDetail
    ).toMatchObject({ measurementsInvalid: 1 });
  });

  test("a chain and its measurements naming different analyzers is a mismatch", () => {
    const stageResults = chainOf({});
    const row = aggregate([
      trial({
        stageResults,
        measurements: {
          ...deriveStageMeasurements({ stageResults }),
          stageAnalyzerVersion: STAGE_ANALYZER_VERSION - 1,
        },
      }),
    ]);
    expect(row.excludedTrialDetail.analyzerMismatch).toBe(1);
  });

  test("an evaluator error is never folded into a server failure", () => {
    const row = aggregate([trial({ evaluatorErrored: true })]);
    expect(row.excludedTrialDetail.evaluatorError).toBe(1);
    expect(stageOf(row, "call").failed).toBe(0);
  });

  test("lifecycle is decided BEFORE integrity", () => {
    // A cancelled trial's missing chain is not an integrity problem; reporting
    // it as one would fill the integrity tally with runs somebody stopped.
    expect(
      classifyStageAnalyticsTrial(
        trial({ status: "cancelled", stageResults: undefined }),
        STAGE_ANALYZER_VERSION,
        1
      )
    ).toEqual({ class: "lifecycle", detail: "cancelled" });
  });

  test("an excluded trial contributes NO observation to any stage", () => {
    const row = aggregate([
      trial({ trialKey: "good" }),
      trial({ trialKey: "bad", status: "cancelled" }),
    ]);
    // The denominator is 1, not 2 — and the drop is named, not silent.
    expect(measuredPassRate(stageOf(row, "call")).denominator).toBe(1);
    expect(row.totalTrials).toBe(2);
    expect(row.includedTrials).toBe(1);
    expect(overallOf(row).excludedTrials.lifecycle).toBe(1);
  });
});

// ── slices ───────────────────────────────────────────────────────────────────

describe("marginal slices", () => {
  test("a trial votes once in each dimension, and there is no cross-product", () => {
    const row = aggregate([
      trial({
        intent: "search",
        provider: "anthropic",
        model: "m",
        hostKey: "h",
      }),
    ]);
    expect(row.slices.map((s) => s.slice.dimension)).toEqual([
      "overall",
      "intent",
      "model",
      "host",
    ]);
    for (const slice of row.slices) expect(slice.includedTrials).toBe(1);
  });

  test("unlabelled intent is a real slice keyed on null, and sorts last", () => {
    const row = aggregate([
      trial({ trialKey: "a", intent: "search" }),
      trial({ trialKey: "b" }),
      trial({ trialKey: "c", intent: "  " }),
    ]);
    const intents = row.slices.filter((s) => s.slice.dimension === "intent");
    expect(
      intents.map((s) => (s.slice as { intent: string | null }).intent)
    ).toEqual(["search", null]);
    // Whitespace-only and absent are the SAME slice — one spelling of absence.
    expect(intents[1]!.includedTrials).toBe(2);
  });

  test("no model/host slice is invented for a trial that records neither", () => {
    // An "unknown model" row would invite a comparison against it.
    const row = aggregate([trial({})]);
    expect(row.slices.some((s) => s.slice.dimension === "model")).toBe(false);
    expect(row.slices.some((s) => s.slice.dimension === "host")).toBe(false);
  });

  test("model slices are keyed by provider AND model", () => {
    const row = aggregate([
      trial({ trialKey: "a", provider: "anthropic", model: "m" }),
      trial({ trialKey: "b", provider: "openai", model: "m" }),
    ]);
    expect(
      row.slices.filter((s) => s.slice.dimension === "model")
    ).toHaveLength(2);
  });

  test("a name containing the delimiter cannot merge two model slices", () => {
    // `("a b", "c")` and `("a", "b c")` join to the same string under any
    // delimiter that can itself appear in a name. Merged, one slice would
    // report combined counts under whichever metadata was seen first — a
    // comparison between two models that is silently neither.
    const row = aggregate([
      trial({ trialKey: "a", provider: "a b", model: "c" }),
      trial({ trialKey: "b", provider: "a", model: "b c" }),
    ]);
    const models = row.slices.filter((s) => s.slice.dimension === "model");
    expect(models).toHaveLength(2);
    for (const model of models) expect(model.includedTrials).toBe(1);
    expect(
      models.map((s) => {
        const slice = s.slice as { provider: string; model: string };
        return [slice.provider, slice.model];
      })
    ).toEqual([
      // Canonical order is over the JSON encoding, so `"a b"` precedes `"a"`
      // here (space sorts before the closing quote). Arbitrary-looking, but
      // deterministic — which is the property a rebuild depends on.
      ["a b", "c"],
      ["a", "b c"],
    ]);
  });

  test("host slices carry the execution engine when it was recorded", () => {
    const row = aggregate([
      trial({
        hostKey: "h1",
        hostName: "Claude Code",
        executionEngine: "harness:cc",
      }),
    ]);
    expect(row.slices.find((s) => s.slice.dimension === "host")!.slice).toEqual(
      {
        dimension: "host",
        hostKey: "h1",
        hostName: "Claude Code",
        executionEngine: "harness:cc",
      }
    );
  });

  test("truncation is RECORDED, never silent", () => {
    // A truncated slice array with no such record reads as "these are all the
    // intents", and a comparison over an unknowingly partial set is worse than
    // no comparison.
    const trials = Array.from({ length: 60 }, (_, i) =>
      trial({
        trialKey: `i${i}`,
        intent: `intent-${String(i).padStart(3, "0")}`,
      })
    );
    const row = aggregate(trials);
    expect(row.sliceTruncation).toEqual([
      { dimension: "intent", distinctValues: 60, retained: 50 },
    ]);
    expect(row.includedTrials).toBe(60);
  });

  test("failure categories are tallied per slice, over trials", () => {
    const row = aggregate([
      trial({ trialKey: "a", failureCategory: "selection", intent: "search" }),
      trial({ trialKey: "b", failureCategory: "metadata", intent: "search" }),
    ]);
    const intent = row.slices.find((s) => s.slice.dimension === "intent")!;
    // Ordered by the vocabulary, not by count — so a chart does not reorder
    // itself between two runs.
    expect(intent.failureCategories).toEqual([
      { category: "metadata", count: 1 },
      { category: "selection", count: 1 },
    ]);
  });

  test("stage reasons are kept beside categories and ordered by vocabulary", () => {
    const row = aggregate([
      trial({
        stageResults: chainOf(
          { selection: "failed" },
          { selection: "missingToolCall" }
        ),
        failureCategory: "selection",
      }),
    ]);
    expect(stageOf(row, "selection").reasons).toEqual([
      { reason: "missingToolCall", count: 1 },
    ]);
  });
});

// ── latency ──────────────────────────────────────────────────────────────────

describe("latency aggregation", () => {
  test("sums and bounds accumulate; the mean is derived from count + sum", () => {
    const withSpan = (key: string, start: number, end: number) => {
      const stageResults = chainOf({});
      stageResults[3] = {
        stage: "call",
        state: "passed",
        evidence: { spanIds: ["t"] },
      };
      return trial({
        trialKey: key,
        stageResults,
        measurements: deriveStageMeasurements({
          stageResults,
          spans: [{ id: "t", startedAt: start, endedAt: end }],
        }),
      });
    };
    const row = aggregate([withSpan("a", 0, 100), withSpan("b", 0, 300)]);
    const call = stageOf(row, "call");
    expect(call.latency).toEqual({
      unit: "ms",
      basis: "evidence_span_union",
      sampleCount: 2,
      totalMs: 400,
      minMs: 100,
      maxMs: 300,
    });
    expect(latencyMeanMs(call.latency)).toBe(200);
  });

  test("no samples means no aggregate, and no mean", () => {
    const row = aggregate([trial()]);
    expect(stageOf(row, "call").latency).toBeUndefined();
    expect(latencyMeanMs(undefined)).toBeNull();
  });

  test("a row that describes another stage contributes NO latency", () => {
    // A misordered measurement payload. Reach already falls back to the
    // chain's own state; reading latency off the same row anyway would file
    // one stage's duration under another, and a wrong number is
    // indistinguishable from a right one once summed into an aggregate.
    const stageResults = chainOf({});
    stageResults[2] = {
      stage: "selection",
      state: "passed",
      evidence: { spanIds: ["p"] },
    };
    const measurements = deriveStageMeasurements({
      stageResults,
      spans: [{ id: "p", startedAt: 0, endedAt: 400 }],
    });
    expect(measurements.rows[2]!.latency?.value).toBe(400);

    // Put selection's row — carrying its 400ms — at the `call` index.
    const corrupted = {
      ...measurements,
      rows: measurements.rows.map((r, i) =>
        i === 3 ? measurements.rows[2]! : r
      ),
    };
    const row = aggregate([trial({ stageResults, measurements: corrupted })]);

    expect(stageOf(row, "call").latency).toBeUndefined();
    // The stage whose own row is intact keeps its sample.
    expect(stageOf(row, "selection").latency?.totalMs).toBe(400);
  });
});

// ── setup ────────────────────────────────────────────────────────────────────

describe("setup — one attempt per run+phase, impact per trial", () => {
  test("N copied signals yield 1 attempt, 1 latency sample, N impacted trials", () => {
    // The required reading. Counting the copies would report one 3-second
    // connect as having been measured N times.
    const signals = Array.from({ length: 5 }, (_, i) => ({
      phase: "connection" as const,
      outcome: "failed" as const,
      attribution: "theirs" as const,
      egressVerified: true,
      durationMs: 3000,
      trialKey: `i${i}`,
    }));
    const row = aggregate([trial({ status: "setup_failed" })], {}, signals);
    expect(row.setup).toEqual([
      {
        phase: "connection",
        uniqueAttempts: 1,
        failedAttempts: 1,
        serverAttributedFailures: 1,
        impactedTrials: 5,
        latency: {
          unit: "ms",
          basis: "setup_phase_wall",
          sampleCount: 1,
          totalMs: 3000,
          minMs: 3000,
          maxMs: 3000,
        },
      },
    ]);
  });

  test("server attribution requires `theirs` AND a positive egress canary", () => {
    // Blaming a server for our own network is the failure this narrow rule
    // exists to prevent.
    expect(
      isServerAttributedSetupFailure({
        outcome: "failed",
        attribution: "theirs",
        egressVerified: true,
      })
    ).toBe(true);
    for (const signal of [
      { outcome: "failed", attribution: "theirs" },
      { outcome: "failed", attribution: "theirs", egressVerified: false },
      { outcome: "failed", attribution: "unknown", egressVerified: true },
      { outcome: "failed", attribution: "ours", egressVerified: true },
      { outcome: "ok", attribution: "theirs", egressVerified: true },
    ]) {
      expect(isServerAttributedSetupFailure(signal)).toBe(false);
    }
  });

  test("a successful phase records an attempt and no impact", () => {
    const row = aggregate([trial()], {}, [
      { phase: "discovery", outcome: "ok", durationMs: 40, trialKey: "i1" },
    ]);
    expect(row.setup[0]).toMatchObject({
      phase: "discovery",
      uniqueAttempts: 1,
      failedAttempts: 0,
      impactedTrials: 0,
    });
  });

  test("a phase with no signal produces no row at all", () => {
    expect(aggregate([trial()]).setup).toEqual([]);
  });
});

// ── determinism, validity, parity ────────────────────────────────────────────

describe("the row itself", () => {
  test("validates, and pins trial as the measurement unit", () => {
    const row = aggregate([
      trial({
        intent: "search",
        provider: "anthropic",
        model: "m",
        hostKey: "h",
      }),
    ]);
    const parsed = evalStageAnalyticsSchema.safeParse(row);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
    expect(row.measurementUnit).toBe("trial");
    expect(row.schemaVersion).toBe(1);
  });

  test("is deterministic under input reordering", () => {
    // A rebuild after a judge fanout must be comparable to the row it replaces.
    const trials = [
      trial({
        trialKey: "a",
        intent: "b",
        provider: "p",
        model: "m1",
        hostKey: "h1",
      }),
      trial({
        trialKey: "b",
        intent: "a",
        provider: "p",
        model: "m2",
        hostKey: "h2",
      }),
      trial({
        trialKey: "c",
        intent: "c",
        provider: "p",
        model: "m1",
        hostKey: "h1",
      }),
    ];
    expect(JSON.stringify(aggregate(trials))).toBe(
      JSON.stringify(aggregate([...trials].reverse()))
    );
  });

  test("createdAt is preserved across a rebuild; updatedAt moves", () => {
    const first = aggregate([trial()], { now: 1000 });
    const rebuilt = aggregate([trial()], {
      now: 2000,
      createdAt: first.createdAt,
    });
    expect(rebuilt.createdAt).toBe(first.createdAt);
    expect(rebuilt.updatedAt).toBe(2000);
  });

  test("stamps the version the trials were ACTUALLY derived at", () => {
    // Not the reader's. An older trial is included — excluding it would
    // discard nearly all history the first time the analyzer bumps — so the
    // row must report what produced it, or old semantics claim new ones.
    const older = STAGE_ANALYZER_VERSION - 1;
    const stageResults = chainOf({});
    const row = aggregate([
      trial({
        stageResults,
        stageAnalyzerVersion: older,
        measurements: {
          ...deriveStageMeasurements({ stageResults }),
          stageAnalyzerVersion: older,
        },
      }),
    ]);
    expect(row.includedTrials).toBe(1);
    expect(row.stageAnalyzerVersion).toBe(older);
    expect(row.stageAnalyzerVersion).not.toBe(STAGE_ANALYZER_VERSION);
    // Uniform, so no mixed list — and the row stays comparable.
    expect(row.sourceStageAnalyzerVersions).toBeUndefined();
    expect(evalStageAnalyticsSchema.safeParse(row).success).toBe(true);
  });

  test("a run mixing analyzer versions says so, and is not comparable", () => {
    const older = STAGE_ANALYZER_VERSION - 1;
    const oldChain = chainOf({});
    const row = aggregate([
      trial({ trialKey: "new" }),
      trial({
        trialKey: "old",
        stageResults: oldChain,
        stageAnalyzerVersion: older,
        measurements: {
          ...deriveStageMeasurements({ stageResults: oldChain }),
          stageAnalyzerVersion: older,
        },
      }),
    ]);
    expect(row.includedTrials).toBe(2);
    expect(row.sourceStageAnalyzerVersions).toEqual([
      older,
      STAGE_ANALYZER_VERSION,
    ]);
    // The stamp is the newest present, but nothing may rest on it alone.
    expect(row.stageAnalyzerVersion).toBe(STAGE_ANALYZER_VERSION);
    expect(evalStageAnalyticsSchema.safeParse(row).success).toBe(true);

    // Incomparable to anything — including a row with the same stamp, and
    // including another mixed row.
    expect(stageAnalyticsParityBlockers(row, row)).toContain(
      "mixedSourceVersions"
    );
    const uniform = aggregate([trial()]);
    expect(stageAnalyticsParityBlockers(row, uniform)).toContain(
      "mixedSourceVersions"
    );
    // The uniform pair is still fine, so the blocker is not firing on everything.
    expect(stageAnalyticsParityBlockers(uniform, uniform)).toEqual([]);
  });

  test("a run with no included trials falls back to the reader's version", () => {
    // Zero observations make no semantic claim, so there is no source version.
    const row = aggregate([trial({ status: "cancelled" })]);
    expect(row.includedTrials).toBe(0);
    expect(row.stageAnalyzerVersion).toBe(STAGE_ANALYZER_VERSION);
    expect(row.sourceStageAnalyzerVersions).toBeUndefined();
  });

  test("provisional and final are carried, never inferred from the trials", () => {
    expect(
      aggregate([trial()], { materializationState: "provisional" })
        .materializationState
    ).toBe("provisional");
  });

  test("counts and bounds that describe different sample sets are rejected", () => {
    const row = aggregate([trial()]);
    const bad = structuredClone(row) as EvalStageAnalyticsV1;
    bad.slices[0]!.stages[3]!.latency = {
      unit: "ms",
      basis: "evidence_span_union",
      sampleCount: 2,
      totalMs: 1,
      minMs: 100,
      maxMs: 300,
    };
    expect(evalStageAnalyticsSchema.safeParse(bad).success).toBe(false);
  });
});

describe("parity", () => {
  const base = {
    runGroupId: "g1",
    stageAnalyzerVersion: STAGE_ANALYZER_VERSION,
    measurementsSchemaVersion: 1,
    measurementUnit: "trial" as const,
    materializationState: "final" as const,
  };

  test("compatible rows have no blockers", () => {
    expect(stageAnalyticsParityBlockers(base, base)).toEqual([]);
  });

  test.each([
    ["differentRunGroup", { runGroupId: "g2" }],
    ["differentAnalyzerVersion", { stageAnalyzerVersion: 99 }],
    ["differentMeasurementsVersion", { measurementsSchemaVersion: 2 }],
    ["provisional", { materializationState: "provisional" as const }],
  ])("%s blocks a side-by-side comparison", (blocker, over) => {
    expect(stageAnalyticsParityBlockers(base, { ...base, ...over })).toContain(
      blocker
    );
  });

  test("an ungrouped pair is not silently declared comparable", () => {
    // Both undefined DOES compare equal — that is deliberate; the blocker
    // exists for a mismatch, and callers gate on run-group presence upstream.
    expect(
      stageAnalyticsParityBlockers(
        { ...base, runGroupId: undefined },
        { ...base, runGroupId: "g1" }
      )
    ).toContain("differentRunGroup");
  });
});
