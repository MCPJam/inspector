/**
 * `StageMeasurementsV1` — reach, and the span-union latency.
 *
 * The properties, not the branches:
 *
 *   - reach is a projection of state, EXCEPT for the one upgrade that makes
 *     measurement coverage a real number;
 *   - overlapping spans are counted ONCE (a parallel server is not a slow one);
 *   - and every kind of broken timestamp yields NO SAMPLE, never a zero — the
 *     failure that would drag every mean toward zero exactly where
 *     instrumentation is worst.
 */

import { describe, expect, test } from "vitest";
import {
  LATENCY_BASIS_EVIDENCE_SPAN_UNION,
  STAGE_ANALYZER_VERSION,
  STAGE_LATENCY_ELIGIBLE_STAGES,
  STAGE_MEASUREMENTS_SCHEMA_VERSION,
  USER_VALUE_STAGES,
  deriveStageMeasurements,
  reachForStageState,
  reachIsConsistentWithState,
  stageMeasurementDisagreements,
  stageMeasurementsSchema,
  unionDurationMs,
  type StageMeasurementsV1,
  type StageResultRow,
  type UserValueStage,
} from "../src/contract/index.js";

const row = (
  stage: UserValueStage,
  state: StageResultRow["state"],
  spanIds?: string[]
): StageResultRow => ({
  stage,
  state,
  ...(spanIds ? { evidence: { spanIds } } : {}),
});

/** Six rows, all in one state, so a test can vary exactly one of them. */
const chain = (state: StageResultRow["state"] = "passed"): StageResultRow[] =>
  USER_VALUE_STAGES.map((stage) => row(stage, state));

const span = (id: string, startedAt?: unknown, endedAt?: unknown) =>
  ({ id, startedAt, endedAt } as never);

describe("reach", () => {
  test("a failed stage was REACHED", () => {
    // Excluding failures from `reached` would make a funnel narrow exactly
    // where things went wrong, which is the one place it must not.
    expect(reachForStageState("failed")).toBe("reached");
    expect(reachForStageState("passed")).toBe("reached");
    expect(reachForStageState("notReached")).toBe("notReached");
    expect(reachForStageState("notApplicable")).toBe("notApplicable");
    expect(reachForStageState("notMeasured")).toBe("unknown");
  });

  test("notMeasured is the ONLY state that admits two reaches", () => {
    expect(reachIsConsistentWithState("notMeasured", "unknown")).toBe(true);
    expect(reachIsConsistentWithState("notMeasured", "reached")).toBe(true);
    expect(reachIsConsistentWithState("notMeasured", "notReached")).toBe(false);
    expect(reachIsConsistentWithState("passed", "unknown")).toBe(false);
    expect(reachIsConsistentWithState("notReached", "reached")).toBe(false);
  });

  test("cited, resolvable evidence upgrades notMeasured to reached", () => {
    // This upgrade is what makes `measured / reached` capable of being < 1. If
    // reach were a pure function of state, coverage would be 1 in every run
    // ever recorded and the metric could never report under-instrumentation.
    const rows = chain("notMeasured");
    rows[2] = row("selection", "notMeasured", ["a"]);
    const out = deriveStageMeasurements({
      stageResults: rows,
      spans: [span("a", 10, 30)],
    });
    expect(out.rows[2]).toMatchObject({ stage: "selection", reach: "reached" });
    expect(out.rows[1]!.reach).toBe("unknown");
  });

  test("an unresolvable span id does NOT upgrade reach", () => {
    const rows = chain("notMeasured");
    rows[2] = row("selection", "notMeasured", ["ghost"]);
    const out = deriveStageMeasurements({ stageResults: rows, spans: [] });
    expect(out.rows[2]!.reach).toBe("unknown");
  });
});

describe("unionDurationMs", () => {
  test("overlap is counted once", () => {
    // Two 500ms calls that ran concurrently took 500ms of wall time. Summing
    // durations would report a parallel server as twice as slow as it is.
    expect(
      unionDurationMs([
        { start: 0, end: 500 },
        { start: 250, end: 500 },
      ])
    ).toBe(500);
  });

  test("disjoint intervals add", () => {
    expect(
      unionDurationMs([
        { start: 0, end: 10 },
        { start: 20, end: 25 },
      ])
    ).toBe(15);
  });

  test("nested and adjacent intervals do not double count", () => {
    expect(
      unionDurationMs([
        { start: 0, end: 100 },
        { start: 10, end: 20 },
      ])
    ).toBe(100);
    expect(
      unionDurationMs([
        { start: 0, end: 10 },
        { start: 10, end: 20 },
      ])
    ).toBe(20);
  });

  test("input order does not matter", () => {
    const a = [
      { start: 20, end: 25 },
      { start: 0, end: 10 },
    ];
    const b = [
      { start: 0, end: 10 },
      { start: 20, end: 25 },
    ];
    expect(unionDurationMs(a)).toBe(unionDurationMs(b));
  });

  test("no intervals is zero, and no interval is ever synthesized", () => {
    expect(unionDurationMs([])).toBe(0);
  });
});

describe("latency", () => {
  const withSelectionSpans = (spans: unknown[]) => {
    const rows = chain("passed");
    rows[2] = row("selection", "passed", ["a", "b"]);
    return deriveStageMeasurements({
      stageResults: rows,
      spans: spans as never[],
    });
  };

  test("is the union of the stage's OWN cited spans", () => {
    const out = withSelectionSpans([span("a", 0, 500), span("b", 250, 800)]);
    expect(out.rows[2]!.latency).toEqual({
      unit: "ms",
      basis: LATENCY_BASIS_EVIDENCE_SPAN_UNION,
      value: 800,
    });
  });

  test.each([
    ["a missing endedAt", [span("a", 0, undefined)]],
    ["a null startedAt", [span("a", null, 500)]],
    ["a non-numeric stamp", [span("a", "0", "500")]],
    ["a NaN stamp", [span("a", Number.NaN, 500)]],
    ["an infinite stamp", [span("a", 0, Number.POSITIVE_INFINITY)]],
    ["an end before its start", [span("a", 500, 0)]],
  ])("omits the sample entirely for %s", (_label, spans) => {
    // NO SAMPLE, never a zero — and never a clamp, which would launder a clock
    // fault into a measurement.
    expect(withSelectionSpans(spans).rows[2]!.latency).toBeUndefined();
  });

  test("a zero-length span IS a sample", () => {
    // Sub-millisecond is a real observation; absence is spelled by omission.
    expect(withSelectionSpans([span("a", 7, 7)]).rows[2]!.latency?.value).toBe(
      0
    );
  });

  test("only the eligible stages may carry it", () => {
    const rows = USER_VALUE_STAGES.map((stage) => row(stage, "passed", ["a"]));
    const out = deriveStageMeasurements({
      stageResults: rows,
      spans: [span("a", 0, 100)],
    });
    for (const [index, stage] of USER_VALUE_STAGES.entries()) {
      const eligible = (
        STAGE_LATENCY_ELIGIBLE_STAGES as readonly string[]
      ).includes(stage);
      expect(out.rows[index]!.latency === undefined).toBe(!eligible);
    }
    // connection/discovery timing is a run-level SETUP fact counted once per
    // run+phase; userValue has no grader timer yet.
    expect(out.rows[0]!.latency).toBeUndefined();
    expect(out.rows[5]!.latency).toBeUndefined();
  });

  test("call and response may honestly share one round-trip sample", () => {
    const rows = chain("passed");
    rows[3] = row("call", "passed", ["t"]);
    rows[4] = row("response", "passed", ["t"]);
    const out = deriveStageMeasurements({
      stageResults: rows,
      spans: [span("t", 0, 120)],
    });
    expect(out.rows[3]!.latency?.value).toBe(120);
    expect(out.rows[4]!.latency?.value).toBe(120);
  });
});

describe("shape", () => {
  test("always six rows in canonical order, whatever the input", () => {
    for (const input of [
      { stageResults: [] },
      { stageResults: chain("failed") },
      { stageResults: [row("userValue", "passed")] },
    ]) {
      const out = deriveStageMeasurements(input);
      expect(out.rows.map((r) => r.stage)).toEqual([...USER_VALUE_STAGES]);
    }
  });

  test("output validates", () => {
    const out = deriveStageMeasurements({ stageResults: chain("passed") });
    expect(stageMeasurementsSchema.safeParse(out).success).toBe(true);
    expect(out.schemaVersion).toBe(STAGE_MEASUREMENTS_SCHEMA_VERSION);
    expect(out.stageAnalyzerVersion).toBe(STAGE_ANALYZER_VERSION);
  });

  test("a reordered payload is REJECTED, not silently re-read", () => {
    const out = deriveStageMeasurements({ stageResults: chain("passed") });
    const swapped: StageMeasurementsV1 = {
      ...out,
      rows: [out.rows[1]!, out.rows[0]!, ...out.rows.slice(2)],
    };
    expect(stageMeasurementsSchema.safeParse(swapped).success).toBe(false);
  });

  test("latency on a stage that was not reached is rejected", () => {
    const out = deriveStageMeasurements({ stageResults: chain("passed") });
    const bad = {
      ...out,
      rows: out.rows.map((r, i) =>
        i === 2
          ? {
              ...r,
              reach: "notReached" as const,
              latency: {
                unit: "ms" as const,
                basis: LATENCY_BASIS_EVIDENCE_SPAN_UNION,
                value: 10,
              },
            }
          : r
      ),
    };
    expect(stageMeasurementsSchema.safeParse(bad).success).toBe(false);
  });
});

describe("agreement with the chain", () => {
  test("agrees with the derivation it was produced from", () => {
    const rows = chain("passed");
    const out = deriveStageMeasurements({ stageResults: rows });
    expect(
      stageMeasurementDisagreements(out, rows, STAGE_ANALYZER_VERSION)
    ).toEqual([]);
  });

  test("catches measurements paired with a DIFFERENT run's chain", () => {
    // Nothing but this function notices if a caller pairs last run's
    // measurements with this run's chain.
    const out = deriveStageMeasurements({ stageResults: chain("passed") });
    const problems = stageMeasurementDisagreements(
      out,
      chain("notReached"),
      STAGE_ANALYZER_VERSION
    );
    expect(problems.length).toBe(USER_VALUE_STAGES.length);
    expect(problems[0]).toMatch(/reach 'reached'.*'notReached' does not admit/);
  });

  test("catches an analyzer-version mismatch", () => {
    const out = deriveStageMeasurements({ stageResults: chain("passed") });
    expect(
      stageMeasurementDisagreements(
        out,
        chain("passed"),
        STAGE_ANALYZER_VERSION + 1
      )
    ).toContainEqual(expect.stringContaining("stageAnalyzerVersion"));
  });
});

describe("judge rebuild parity", () => {
  test("re-deriving from rewritten attribution is deterministic", () => {
    // The judge second pass reruns this same pure helper. Same spans + same
    // rewritten rows must produce byte-identical measurements, or a rebuild
    // would appear to change timings that never moved.
    const rewritten = chain("passed");
    rewritten[2] = row("selection", "failed", ["a"]);
    const spans = [span("a", 5, 55)];
    const first = deriveStageMeasurements({ stageResults: rewritten, spans });
    const second = deriveStageMeasurements({ stageResults: rewritten, spans });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.rows[2]!.latency?.value).toBe(50);
  });
});
