import { describe, expect, it } from "vitest";
import {
  buildRunCompareLanes,
  resolveSuitePassThreshold,
  runCompareLaneKey,
} from "../run-compare-lanes-model";
import type { EvalIteration, EvalSuiteRun } from "../../evals/types";
import { metricsByRunFromIterations } from "../../evals/run-metrics";

function makeRun(
  overrides: Partial<EvalSuiteRun> & { _id: string },
): EvalSuiteRun {
  return {
    suiteId: "suite-1",
    createdBy: "u1",
    runNumber: 1,
    configRevision: "1",
    configSnapshot: { tests: [], environment: { servers: [] } },
    status: "completed",
    result: "passed",
    createdAt: 1_700_000_000_000,
    completedAt: 1_700_000_010_000,
    source: "ui",
    summary: { total: 1, passed: 1, failed: 0, passRate: 100 },
    ...overrides,
  } as unknown as EvalSuiteRun;
}

/** One completed trial. `updatedAt - startedAt` is what the latency reads. */
function trial(
  runId: string,
  index: number,
  overrides: { tokensUsed?: number; latencyMs?: number; result?: string } = {},
): EvalIteration {
  const { tokensUsed = 100, latencyMs = 1000, result = "passed" } = overrides;
  return {
    _id: `${runId}-it-${index}`,
    suiteRunId: runId,
    testCaseId: `case-${index}`,
    status: "completed",
    result,
    tokensUsed,
    actualToolCalls: [],
    createdAt: 0,
    startedAt: 0,
    updatedAt: latencyMs,
  } as unknown as EvalIteration;
}

/** `n` identical trials, so p50 and p95 are both exactly `latencyMs`. */
function trials(
  runId: string,
  count: number,
  overrides?: { tokensUsed?: number; latencyMs?: number },
): EvalIteration[] {
  return Array.from({ length: count }, (_, index) =>
    trial(runId, index, overrides),
  );
}

function environmentSnapshot(environmentId: string, revision: number) {
  return {
    tests: [],
    environment: { servers: [] },
    environmentRef: {
      environmentId,
      name: `Environment ${environmentId}`,
      revision,
    },
  };
}

function build(
  runs: EvalSuiteRun[],
  iterations: EvalIteration[],
  options: { currentRun?: EvalSuiteRun; passThreshold?: number | null } = {},
) {
  return buildRunCompareLanes({
    currentRun: options.currentRun ?? runs[0],
    runs,
    metricsByRun: metricsByRunFromIterations(iterations),
    hostNamesById: new Map<string, string | null>(),
    passThreshold: options.passThreshold ?? null,
  });
}

function laneFor(result: ReturnType<typeof build>, key: string) {
  const lane = result.lanes.find((candidate) => candidate.key === key);
  if (!lane)
    throw new Error(
      `no lane ${key} in ${result.lanes.map((l) => l.key).join(", ")}`,
    );
  return lane;
}

describe("runCompareLaneKey", () => {
  it("keys on the environment, and on client × model without one", () => {
    // An environment already pins client AND model, so its revisions stay one
    // lane — otherwise editing an environment restarts the trend.
    const rev1 = makeRun({
      _id: "e1",
      configSnapshot: environmentSnapshot("E", 1) as never,
    });
    const rev2 = makeRun({
      _id: "e2",
      configSnapshot: environmentSnapshot("E", 2) as never,
    });
    expect(runCompareLaneKey(rev1)).toBe("environment:E");
    expect(runCompareLaneKey(rev2)).toBe("environment:E");

    // A host-backed run has no such pin, so the model still splits the lane.
    expect(
      runCompareLaneKey(
        makeRun({ _id: "h1", namedHostId: "H", effectiveModelId: "m1" }),
      ),
    ).toBe("host:H::m1");
    expect(
      runCompareLaneKey(
        makeRun({ _id: "h2", namedHostId: "H", effectiveModelId: "m2" }),
      ),
    ).toBe("host:H::m2");

    // Neither: a historical run with no client identity at all.
    expect(runCompareLaneKey(makeRun({ _id: "bare" }))).toBe("style:unknown::");
  });

  it("folds two revisions of one environment into a single lane", () => {
    const rev1 = makeRun({
      _id: "e1",
      runNumber: 1,
      configSnapshot: environmentSnapshot("E", 1) as never,
    });
    const rev2 = makeRun({
      _id: "e2",
      runNumber: 2,
      configSnapshot: environmentSnapshot("E", 2) as never,
    });
    const result = build(
      [rev2, rev1],
      [...trials("e1", 1), ...trials("e2", 1)],
      {
        currentRun: rev2,
      },
    );
    expect(result.lanes).toHaveLength(1);
    expect(result.lanes[0].rows.map((row) => row.runId)).toEqual(["e2", "e1"]);
  });
});

describe("buildRunCompareLanes", () => {
  it("scopes a fan-out launch's deltas to each lane", () => {
    // Two launches, two arms each. A3's only honest baseline is A2 — the arm
    // that ran the same client and model — not whichever run is chronologically
    // previous, which would report B's tokens as A's regression.
    const a2 = makeRun({
      _id: "A2",
      runNumber: 2,
      runGroupId: "g2",
      namedHostId: "hostA",
    });
    const b2 = makeRun({
      _id: "B2",
      runNumber: 2,
      runGroupId: "g2",
      namedHostId: "hostB",
    });
    const a3 = makeRun({
      _id: "A3",
      runNumber: 3,
      runGroupId: "g3",
      namedHostId: "hostA",
    });
    const b3 = makeRun({
      _id: "B3",
      runNumber: 3,
      runGroupId: "g3",
      namedHostId: "hostB",
    });
    const result = build(
      [a3, b3, a2, b2],
      [
        ...trials("A2", 1, { tokensUsed: 1000 }),
        ...trials("B2", 1, { tokensUsed: 5000 }),
        ...trials("A3", 1, { tokensUsed: 1200 }),
        ...trials("B3", 1, { tokensUsed: 500 }),
      ],
      { currentRun: a3 },
    );

    const laneA = laneFor(result, "host:hostA::");
    expect(laneA.rows[0].runId).toBe("A3");
    expect(laneA.rows[0].baselineRunId).toBe("A2");
    expect(laneA.rows[0].tokens.delta).toMatchObject({
      label: "+200",
      tone: "regression",
    });

    const laneB = laneFor(result, "host:hostB::");
    expect(laneB.rows[0].baselineRunId).toBe("B2");
    expect(laneB.rows[0].tokens.delta).toMatchObject({
      label: "−4.5k",
      tone: "progress",
    });
  });

  it("never makes a launch sibling the baseline, even in the same lane", () => {
    // Two arms of one launch that happen to share a client and model are
    // parallel measurements, not a before and an after.
    const older = makeRun({ _id: "A1", runNumber: 1, namedHostId: "H" });
    const twinA = makeRun({
      _id: "A2",
      runNumber: 2,
      runGroupId: "g",
      namedHostId: "H",
    });
    const twinB = makeRun({
      _id: "A3",
      runNumber: 3,
      runGroupId: "g",
      namedHostId: "H",
    });
    const result = build(
      [twinB, twinA, older],
      [...trials("A1", 1), ...trials("A2", 1), ...trials("A3", 1)],
      { currentRun: twinB },
    );

    const lane = result.lanes[0];
    expect(lane.rows.map((row) => row.runId)).toEqual(["A3", "A2", "A1"]);
    expect(lane.rows[0].baselineRunId).toBe("A1");
    expect(lane.rows[1].baselineRunId).toBe("A1");
  });

  it("withholds every metric from an unsettled run and skips it as a baseline", () => {
    // `grading` is NOT settled: every trial has finished, but the gating judge
    // has not, so the run has no verdict to report yet.
    const older = makeRun({ _id: "R2", runNumber: 2, namedHostId: "H" });
    const grading = makeRun({
      _id: "R3",
      runNumber: 3,
      namedHostId: "H",
      status: "grading",
      result: "pending",
      summary: { total: 1, passed: 1, failed: 0, passRate: 100 },
    });
    const newest = makeRun({ _id: "R4", runNumber: 4, namedHostId: "H" });
    const result = build(
      [newest, grading, older],
      [...trials("R2", 1), ...trials("R3", 1), ...trials("R4", 1)],
      { currentRun: newest },
    );

    const [row4, row3] = result.lanes[0].rows;
    expect(row3).toMatchObject({
      runId: "R3",
      settled: false,
      status: "running",
      passDetail: null,
      baselineRunId: null,
    });
    expect([
      row3.pass.value,
      row3.p50.value,
      row3.p95.value,
      row3.tokens.value,
    ]).toEqual([null, null, null, null]);
    // The newest row reaches past it rather than comparing against nothing.
    expect(row4.baselineRunId).toBe("R2");
  });

  it("reports an incomplete run's stamped pass rate and nothing derived", () => {
    // The summary is authoritative the moment the run settles; the derived
    // metrics are not, because only two of its three trials are on the page.
    const older = makeRun({ _id: "R1", runNumber: 1, namedHostId: "H" });
    const partial = makeRun({
      _id: "R2",
      runNumber: 2,
      namedHostId: "H",
      summary: { total: 3, passed: 2, failed: 1, passRate: 67 },
    });
    const newest = makeRun({ _id: "R3", runNumber: 3, namedHostId: "H" });
    const result = build(
      [newest, partial, older],
      [...trials("R1", 1), ...trials("R2", 2), ...trials("R3", 1)],
      { currentRun: newest },
    );

    const [row3, row2] = result.lanes[0].rows;
    expect(row2).toMatchObject({
      runId: "R2",
      settled: true,
      complete: false,
      passDetail: "2/3",
      baselineRunId: null,
    });
    expect(row2.pass.value).toBe("67%");
    expect(row2.pass.delta).toBeNull();
    expect([row2.p50.value, row2.p95.value, row2.tokens.value]).toEqual([
      null,
      null,
      null,
    ]);
    expect(row3.baselineRunId).toBe("R1");
  });

  it("shows an inconclusive run's pass rate but never trends against it", () => {
    // The platform declined to decide this run. Its counts are exactly the
    // evidence it judged insufficient, so they may be reported and never
    // compared against.
    const older = makeRun({ _id: "R1", runNumber: 1, namedHostId: "H" });
    const undecided = makeRun({
      _id: "R2",
      runNumber: 2,
      namedHostId: "H",
      result: "inconclusive",
      summary: { total: 4, passed: 2, failed: 2, passRate: 50 },
    });
    const newest = makeRun({ _id: "R3", runNumber: 3, namedHostId: "H" });
    const result = build(
      [newest, undecided, older],
      [...trials("R1", 1), ...trials("R2", 4), ...trials("R3", 1)],
      { currentRun: newest },
    );

    const [row3, row2] = result.lanes[0].rows;
    expect(row2.status).toBe("inconclusive");
    expect(row2.pass.value).toBe("50%");
    expect(row2.passDetail).toBe("2/4");
    expect(row2.p50.value).toBeNull();
    expect(row2.pass.delta).toBeNull();
    expect(row3.baselineRunId).toBe("R1");
  });

  it("leaves the first run in a lane with no deltas at all", () => {
    const only = makeRun({ _id: "R1", namedHostId: "H" });
    const result = build([only], trials("R1", 1), { currentRun: only });
    const row = result.lanes[0].rows[0];
    expect(row.baselineRunId).toBeNull();
    expect([
      row.pass.delta,
      row.p50.delta,
      row.p95.delta,
      row.tokens.delta,
    ]).toEqual([null, null, null, null]);
  });

  it("counts only settled lanes against the pass threshold", () => {
    const lane = (
      id: string,
      host: string,
      runNumber: number,
      extra: Partial<EvalSuiteRun>,
    ) =>
      makeRun({
        _id: id,
        runNumber,
        namedHostId: host,
        runGroupId: "launch",
        ...extra,
      });
    const a = lane("A", "hostA", 5, {
      summary: { total: 10, passed: 9, failed: 1, passRate: 90 },
    });
    const b = lane("B", "hostB", 6, {
      summary: { total: 10, passed: 7, failed: 3, passRate: 70 },
    });
    const c = lane("C", "hostC", 7, { status: "running", result: "pending" });
    // History only: this lane has no arm in the current launch.
    const d = makeRun({ _id: "D", runNumber: 1, namedHostId: "hostD" });

    const result = build(
      [a, b, c, d],
      [
        ...trials("A", 10),
        ...trials("B", 10),
        ...trials("C", 4),
        ...trials("D", 1),
      ],
      { currentRun: a, passThreshold: 0.8 },
    );

    expect(result.header).toEqual({
      threshold: 0.8,
      currentRunNumber: 5,
      lanesMeeting: 1,
      lanesSettled: 2,
      lanesRunning: 1,
    });
    expect(result.lanes.map((entry) => entry.rows[0].runId)).toEqual([
      "A",
      "B",
      "C",
      "D",
    ]);
    expect(result.lanes.map((entry) => entry.meetsThreshold)).toEqual([
      true,
      false,
      null,
      null,
    ]);
  });

  it("judges the threshold on a decided run, not merely a settled one", () => {
    // Every one of these is settled with a summary that clears 0.8 on its raw
    // counts, and not one of them is a pass the platform actually decided.
    const lane = (id: string, host: string, extra: Partial<EvalSuiteRun>) =>
      makeRun({
        _id: id,
        runNumber: 1,
        namedHostId: host,
        runGroupId: "launch",
        summary: { total: 10, passed: 9, failed: 1, passRate: 90 },
        ...extra,
      });
    const undecided = lane("A", "hostA", { result: "inconclusive" });
    const stopped = lane("B", "hostB", {
      status: "cancelled",
      result: "cancelled",
    });
    const expired = lane("C", "hostC", { result: "timed_out" });
    const real = lane("D", "hostD", { result: "passed" });

    const result = build(
      [undecided, stopped, expired, real],
      [
        ...trials("A", 10),
        ...trials("B", 10),
        ...trials("C", 10),
        ...trials("D", 10),
      ],
      { currentRun: undecided, passThreshold: 0.8 },
    );

    // Settled counts all four; only the decided one can meet the bar.
    expect(result.header.lanesSettled).toBe(4);
    expect(result.header.lanesMeeting).toBe(1);
    expect(laneFor(result, "host:hostA::").meetsThreshold).toBeNull();
    expect(laneFor(result, "host:hostB::").meetsThreshold).toBeNull();
    expect(laneFor(result, "host:hostC::").meetsThreshold).toBeNull();
    expect(laneFor(result, "host:hostD::").meetsThreshold).toBe(true);
  });

  it("still judges a historical run that carries no result at all", () => {
    // `result` is null on every run older than the field. Requiring an explicit
    // `passed` would drop all of that history out of `lanesMeeting` while
    // `lanesSettled` still counted it — and would label it "Cancelled".
    const legacy = makeRun({
      _id: "L",
      runNumber: 1,
      namedHostId: "H",
      status: "completed",
      result: undefined,
      summary: { total: 10, passed: 9, failed: 1, passRate: 90 },
    });
    const result = build([legacy], trials("L", 10), {
      currentRun: legacy,
      passThreshold: 0.8,
    });

    expect(result.lanes[0].rows[0].status).toBe("completed");
    expect(result.lanes[0].meetsThreshold).toBe(true);
    expect(result.header).toMatchObject({ lanesSettled: 1, lanesMeeting: 1 });
  });

  it("formats each delta's text and tone from the movement's own polarity", () => {
    // More passes is progress; more milliseconds and more tokens are not.
    const first = makeRun({
      _id: "R1",
      runNumber: 1,
      namedHostId: "H",
      summary: { total: 10, passed: 8, failed: 2, passRate: 80 },
    });
    const second = makeRun({
      _id: "R2",
      runNumber: 2,
      namedHostId: "H",
      summary: { total: 10, passed: 9, failed: 1, passRate: 90 },
    });
    const third = makeRun({
      _id: "R3",
      runNumber: 3,
      namedHostId: "H",
      summary: { total: 10, passed: 9, failed: 1, passRate: 90 },
    });
    const result = build(
      [third, second, first],
      [
        ...trials("R1", 10, { latencyMs: 1000, tokensUsed: 300 }),
        ...trials("R2", 10, { latencyMs: 1120, tokensUsed: 180 }),
        ...trials("R3", 10, { latencyMs: 1120, tokensUsed: 180 }),
      ],
      { currentRun: third },
    );

    const [row3, row2] = result.lanes[0].rows;
    expect(row2.pass.delta).toEqual({
      label: "+10%",
      direction: "up",
      tone: "progress",
    });
    expect(row2.p50.delta).toEqual({
      label: "+120ms",
      direction: "up",
      tone: "regression",
    });
    expect(row2.tokens.delta).toEqual({
      label: "−1.2k",
      direction: "down",
      tone: "progress",
    });

    // Nothing moved, so nothing is coloured.
    expect(row3.pass.delta).toEqual({
      label: "=",
      direction: "same",
      tone: "same",
    });
    expect(row3.p50.delta?.tone).toBe("same");
    expect(row3.tokens.delta?.tone).toBe("same");
  });
});

describe("resolveSuitePassThreshold", () => {
  it("reads v2 as a fraction and the legacy policy as a percent", () => {
    // Reading one as the other moves the bar by a factor of a hundred.
    expect(
      resolveSuitePassThreshold({
        verdictPolicyDefaults: { repetitions: 3, passThreshold: 0.8 },
      }),
    ).toBe(0.8);
    expect(
      resolveSuitePassThreshold({
        defaultPassCriteria: { minimumPassRate: 80 },
      }),
    ).toBe(0.8);
    expect(resolveSuitePassThreshold({})).toBeNull();
  });
});
