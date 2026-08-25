import assert from "node:assert/strict";
import test from "node:test";
import {
  EVAL_GATE_INCOMPLETE_EXIT_CODE,
  EVAL_GATE_USAGE_EXIT_CODE,
  evalGateExitCode,
  isNonVerdictRunResult,
  isNonVerdictRunStatus,
} from "../src/lib/eval-gate-exit-code.js";
import {
  assertRunIdBaseline,
  buildBaselineProvenance,
  comparePolicyFromGateOptions,
  evaluateBaselineComparison,
  mergeGateReports,
  policyFromOptions,
  policyNeedsIterations,
  reportForRun,
} from "../src/lib/eval-gate.js";
import type { GateReport } from "@mcpjam/sdk";
import type { PlatformRunCompare } from "@mcpjam/sdk/platform";

function report(outcome: GateReport["outcome"]): GateReport {
  return { outcome, verdicts: [], scoreIntegrity: "unknown" };
}

test("exit codes: incomplete is distinct from an eval failure", () => {
  // "The evals regressed" and "we never established anything" are different
  // failures with different fixes. 2 is taken by usage errors.
  assert.equal(evalGateExitCode(report("passed")), 0);
  assert.equal(evalGateExitCode(report("failed")), 1);
  assert.equal(evalGateExitCode(report("usage_error")), 2);
  assert.equal(evalGateExitCode(report("incomplete")), 3);
});

test("NO infrastructure condition maps to the eval-failure code", () => {
  // A CI job that fails a release because a network call flaked, and reports
  // it as "the server regressed", trains people to ignore the gate.
  const infrastructure = [
    EVAL_GATE_INCOMPLETE_EXIT_CODE, // cancelled run
    EVAL_GATE_INCOMPLETE_EXIT_CODE, // wait timeout
    EVAL_GATE_INCOMPLETE_EXIT_CODE, // network failure
    evalGateExitCode(report("incomplete")), // non-gateable run
  ];
  for (const code of infrastructure) {
    assert.notEqual(code, 1);
    assert.equal(code, 3);
  }
  assert.equal(EVAL_GATE_USAGE_EXIT_CODE, 2);
});

test("an unrecognized outcome fails closed, not open", () => {
  assert.equal(
    evalGateExitCode({ outcome: "who-knows" } as unknown as GateReport),
    3,
  );
});

test("only a COMPLETED run establishes a verdict", () => {
  assert.equal(isNonVerdictRunStatus("cancelled"), true);
  assert.equal(isNonVerdictRunStatus("timed_out"), true);
  // `status: "failed"` is an EXECUTION state — the runner crashed — not the
  // verdict (that is `result`). Its summary describes only the iterations it
  // managed to record before dying, so gating it is fail-open: a run that
  // dies after 3 passing iterations of 30 reads as a 100% pass rate.
  assert.equal(isNonVerdictRunStatus("failed"), true);
  assert.equal(isNonVerdictRunStatus("completed"), false);
  assert.equal(isNonVerdictRunStatus(undefined), false);
});

test("an infra-failed run's partial summary can never gate green", () => {
  // The concrete fail-open scenario the status check exists to close: the
  // runner died after three passing iterations of an intended thirty. The
  // summary alone looks like a perfect run.
  const partial = reportForRun(
    {
      id: "run_1",
      suiteId: "suite_1",
      runNumber: 1,
      status: "completed",
      result: "passed",
      summary: { total: 3, passed: 3, failed: 0 },
    } as never,
    undefined,
    { minimumPassRate: 0.95 },
  );
  // Same summary, run completed: the gate passes — proving the guard below is
  // carried by the STATUS check, not by anything in the numbers.
  assert.equal(partial.outcome, "passed");
  // With status "failed", the command never reaches the engine: the status is
  // non-verdict and the run exits 3 (incomplete), not 0 and not 1.
  assert.equal(isNonVerdictRunStatus("failed"), true);
  assert.equal(
    evalGateExitCode({
      outcome: "incomplete",
      scoreIntegrity: "unknown",
      verdicts: [],
    }),
    3,
  );
});

test("percent flags convert to fractions at the boundary, exactly", () => {
  const policy = policyFromOptions({ minPassRatePercent: "100" });
  // 100% must be the fraction 1 EXACTLY; a hair under and a fully-passing run
  // fails the most common gate anybody writes.
  assert.equal(policy.minimumPassRate, 1);
  assert.equal(policyFromOptions({ minPassRatePercent: "0" }).minimumPassRate, 0);
  assert.equal(
    policyFromOptions({ minPassRatePercent: "95" }).minimumPassRate,
    0.95,
  );
});

test("0 percent is a real threshold, not an unset one", () => {
  assert.equal(policyFromOptions({ minPassRatePercent: "0" }).minimumPassRate, 0);
  assert.equal(policyFromOptions({}).minimumPassRate, undefined);
});

test("out-of-range and non-numeric percents are usage errors", () => {
  for (const bad of ["101", "-1", "abc", ""]) {
    assert.throws(
      () => policyFromOptions({ minPassRatePercent: bad }),
      /between 0 and 100/,
      `expected "${bad}" to be rejected`,
    );
  }
});

test("repeatable scorer flags parse into a fraction map", () => {
  const policy = policyFromOptions({
    minScorerPassRate: ["tone=90", "refund=100"],
    minMeanScore: ["tone=0.8"],
  });
  // Compared by entries, not deepEqual: the maps are null-prototype (so a
  // `__proto__` scorer id lands as a real own key), and `deepEqual` treats a
  // null-prototype object as unequal to an object literal.
  assert.deepEqual(Object.entries(policy.minimumScorerPassRate ?? {}), [
    ["tone", 0.9],
    ["refund", 1],
  ]);
  assert.deepEqual(Object.entries(policy.minimumMeanScore ?? {}), [
    ["tone", 0.8],
  ]);
});

test("a __proto__ scorer id becomes a real entry, not a silent no-op", () => {
  // On a plain object `out["__proto__"] = 0.9` sets the PROTOTYPE, so the gate
  // the author asked for would vanish without a word.
  const policy = policyFromOptions({ minScorerPassRate: ["__proto__=100"] });
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      policy.minimumScorerPassRate ?? {},
      "__proto__",
    ),
    true,
  );
  assert.equal((policy.minimumScorerPassRate as never)["__proto__"], 1);
});

test("naming the same scorer twice is a usage error, not last-wins", () => {
  assert.throws(
    () => policyFromOptions({ minScorerPassRate: ["tone=95", "tone=50"] }),
    /more than once/,
  );
});

test("malformed scorer flags are usage errors", () => {
  assert.throws(
    () => policyFromOptions({ minScorerPassRate: ["tone"] }),
    /<scorerId>=<value>/,
  );
  assert.throws(
    () => policyFromOptions({ minScorerPassRate: ["=90"] }),
    /<scorerId>=<value>/,
  );
  assert.throws(
    () => policyFromOptions({ minMeanScore: ["tone=7"] }),
    /between 0 and 1/,
  );
});

test("only score-derived policies request the iterations fetch", () => {
  assert.equal(policyNeedsIterations({ minimumPassRate: 1 }), false);
  assert.equal(policyNeedsIterations({ noGatingScoreErrors: true }), true);
  assert.equal(
    policyNeedsIterations({ minimumScorerPassRate: { tone: 1 } }),
    true,
  );
  assert.equal(policyNeedsIterations({ minimumMeanScore: { tone: 1 } }), true);
  assert.equal(policyNeedsIterations({ maximumTotalTokens: 10 }), true);
  // p95 comes from iteration durations; without the fetch the latency gate
  // would be permanently non-gateable.
  assert.equal(policyNeedsIterations({ maximumP95LatencyMs: 5000 }), true);
});

const RUN = {
  id: "run_1",
  suiteId: "suite_1",
  runNumber: 1,
  status: "completed",
  result: "passed",
  summary: { total: 4, passed: 4, failed: 0, passRate: 1 },
  source: "sdk",
  notes: null,
  createdAt: 0,
  completedAt: 1,
};

test("a pass-rate gate works against a run with no integrity verdict", () => {
  // The whole point of shipping the gate before the backend integrity check:
  // pass-rate gating is usable today.
  const passing = reportForRun(RUN, undefined, { minimumPassRate: 1 });
  assert.equal(evalGateExitCode(passing), 0);

  const failing = reportForRun(
    { ...RUN, summary: { total: 4, passed: 3, failed: 1, passRate: 0.75 } },
    undefined,
    { minimumPassRate: 1 },
  );
  assert.equal(evalGateExitCode(failing), 1);
});

test("a score gate on a run with no integrity verdict exits 3, never 0", () => {
  const scoreGate = reportForRun(RUN, undefined, {
    minimumScorerPassRate: { tone: 1 },
  });
  assert.equal(evalGateExitCode(scoreGate), 3);
  assert.notEqual(evalGateExitCode(scoreGate), 0);
});

test("an integrity-INVALID run is non-gateable even when every iteration passed", () => {
  const tampered = reportForRun(
    { ...RUN, scoreIntegrity: "invalid" as const },
    { items: [], complete: true },
    { noGatingScoreErrors: true },
  );
  assert.equal(evalGateExitCode(tampered), 3);
});

test("an INCONCLUSIVE run is non-gateable, never a failure", () => {
  // Verdict policy 2 lets the platform decline to decide: the run finished,
  // but too little of it was gradeable to claim anything about the server.
  assert.equal(isNonVerdictRunResult("inconclusive"), true);
  assert.equal(isNonVerdictRunResult("passed"), false);
  assert.equal(isNonVerdictRunResult("failed"), false);
  assert.equal(isNonVerdictRunResult(undefined), false);

  // The fail-either-way trap this closes. The same summary a policy-2 run
  // declared inconclusive would gate GREEN on the numbers alone …
  const green = reportForRun(
    {
      ...RUN,
      result: "inconclusive" as const,
      summary: { total: 2, passed: 2, failed: 0, passRate: 1 },
    } as never,
    undefined,
    { minimumPassRate: 1 },
  );
  assert.equal(green.outcome, "passed");
  // … and a differently-shaped one would gate RED, reading as a regression
  // nobody observed.
  const red = reportForRun(
    {
      ...RUN,
      result: "inconclusive" as const,
      summary: { total: 2, passed: 0, failed: 2, passRate: 0 },
    } as never,
    undefined,
    { minimumPassRate: 1 },
  );
  assert.equal(evalGateExitCode(red), 1);
  // Which is why the command never reaches the engine for an inconclusive
  // result: it reports incomplete, exit 3.
  assert.equal(
    evalGateExitCode({
      outcome: "incomplete",
      scoreIntegrity: "unknown",
      verdicts: [],
    }),
    3,
  );
});

test("the gate keeps exactly four exit codes under verdict policy 2", () => {
  // `inconclusive` is a third RESULT, not a fifth exit code: CI contracts
  // written against 0/1/2/3 keep working.
  const codes = new Set(
    (["passed", "failed", "usage_error", "incomplete"] as const).map((outcome) =>
      evalGateExitCode(report(outcome)),
    ),
  );
  assert.deepEqual([...codes].sort(), [0, 1, 2, 3]);
});

// ── --baseline (runId half) ─────────────────────────────────────────────────

test("assertRunIdBaseline accepts an ordinary run id", () => {
  assert.doesNotThrow(() => assertRunIdBaseline("run_abc123"));
  assert.doesNotThrow(() => assertRunIdBaseline("run-1"));
});

test("assertRunIdBaseline rejects a 40-hex git SHA, upper or lower case", () => {
  const sha = "a".repeat(40);
  assert.throws(
    () => assertRunIdBaseline(sha),
    /SHA baselines are not supported yet/,
  );
  assert.throws(
    () => assertRunIdBaseline(sha.toUpperCase()),
    /SHA baselines are not supported yet/,
  );
  // One character short or long is not the SHA shape — a real run id could
  // plausibly look like this, so it must NOT be rejected.
  assert.doesNotThrow(() => assertRunIdBaseline("a".repeat(39)));
  assert.doesNotThrow(() => assertRunIdBaseline("a".repeat(41)));
  // Not all-hex: also not the SHA shape.
  assert.doesNotThrow(() => assertRunIdBaseline("g".repeat(40)));
});

test("comparePolicyFromGateOptions: --baseline alone implies regression gating", () => {
  // No `--gate-regressions` flag exists on `eval gate` — `--baseline` itself
  // enables the pass-rate regression gate with the SDK's defaults.
  const policy = comparePolicyFromGateOptions({ baseline: "run_1" });
  assert.deepEqual(policy.passRateRegression, {});
});

test("comparePolicyFromGateOptions: no --baseline produces an empty policy", () => {
  assert.deepEqual(comparePolicyFromGateOptions({}), {});
});

test("comparePolicyFromGateOptions: every comparative flag requires --baseline", () => {
  for (const options of [
    { minSampleSize: "10" },
    { minEffectSizePercent: "5" },
    { gateDeterministicRegressions: true },
    { maxP95LatencyIncreaseMs: "100" },
  ]) {
    assert.throws(
      () => comparePolicyFromGateOptions(options),
      /pass --baseline/,
      JSON.stringify(options),
    );
  }
});

test("comparePolicyFromGateOptions: tuning flags apply once --baseline is set", () => {
  const policy = comparePolicyFromGateOptions({
    baseline: "run_1",
    minSampleSize: "10",
    minEffectSizePercent: "1",
    gateDeterministicRegressions: true,
    maxP95LatencyIncreaseMs: "250",
  });
  assert.equal(policy.passRateRegression?.minSampleSize, 10);
  // Percent -> fraction at the boundary, same conversion `eval compare` uses.
  assert.equal(policy.passRateRegression?.minEffectSize, 0.01);
  assert.equal(policy.noDeterministicRegressions, true);
  assert.equal(policy.maximumP95LatencyIncreaseMs, 250);
});

function gateReport(
  outcome: GateReport["outcome"],
  verdicts: GateReport["verdicts"] = [],
): GateReport {
  return { outcome, verdicts, scoreIntegrity: "unknown" };
}

test("mergeGateReports: outcome follows usage_error > failed > incomplete > passed", () => {
  const cases: Array<
    [GateReport["outcome"], GateReport["outcome"], GateReport["outcome"]]
  > = [
    ["passed", "passed", "passed"],
    ["failed", "passed", "failed"],
    ["passed", "failed", "failed"],
    ["passed", "incomplete", "incomplete"],
    ["failed", "incomplete", "failed"],
    ["incomplete", "failed", "failed"],
    ["usage_error", "failed", "usage_error"],
    ["failed", "usage_error", "usage_error"],
  ];
  for (const [threshold, comparative, expected] of cases) {
    assert.equal(
      mergeGateReports(gateReport(threshold), gateReport(comparative)).outcome,
      expected,
      `${threshold} + ${comparative}`,
    );
  }
});

test("mergeGateReports: every verdict from both halves survives, neither buries the other", () => {
  const threshold = gateReport("failed", [
    { gate: "minimumPassRate", status: "failed", message: "1/2 passed" },
  ]);
  const comparative = gateReport("failed", [
    { gate: "passRateRegression", status: "failed", message: "regressed" },
  ]);
  const merged = mergeGateReports(threshold, comparative);
  assert.deepEqual(
    merged.verdicts.map((v) => v.gate),
    ["minimumPassRate", "passRateRegression"],
  );
});

test("mergeGateReports: scoreIntegrity carries the RUN's own value, not the comparison's", () => {
  const threshold = gateReport("passed");
  const merged = mergeGateReports(
    { ...threshold, scoreIntegrity: "valid" },
    { ...gateReport("passed"), scoreIntegrity: "invalid" },
  );
  assert.equal(merged.scoreIntegrity, "valid");
});

const ZERO_DIFF = {
  base: null,
  compare: null,
  delta: null,
  percentDelta: null,
};

function compareWire(
  overrides: Partial<PlatformRunCompare> = {},
): PlatformRunCompare {
  return {
    suite: { id: "s1", name: "Suite" },
    baseline: { policy: "run", baseRunId: "run_base" },
    baseRun: {
      id: "run_base",
      runNumber: 1,
      result: "passed",
      createdAt: 1,
      completedAt: 2,
      summary: { total: 70, passed: 56, failed: 14, passRate: 0.8 },
    },
    compareRun: {
      id: "run_compare",
      runNumber: 2,
      result: "failed",
      createdAt: 3,
      completedAt: 4,
      summary: { total: 80, passed: 48, failed: 32, passRate: 0.6 },
    },
    passSummary: {
      passRatePercent: ZERO_DIFF,
      total: ZERO_DIFF,
      passed: ZERO_DIFF,
      failed: ZERO_DIFF,
    },
    metrics: {
      wallDurationMs: ZERO_DIFF,
      totalTokens: ZERO_DIFF,
      estimatedCostUsd: ZERO_DIFF,
    },
    scoreContract: {
      base: {
        evaluationConfigHash: "cfg",
        scoreIntegrity: "valid",
        scoredIterations: 70,
        quarantinedIterations: 0,
      },
      compare: {
        evaluationConfigHash: "cfg",
        scoreIntegrity: "valid",
        scoredIterations: 80,
        quarantinedIterations: 0,
      },
      evaluationConfigChanged: false,
      scorers: [],
    },
    cases: [
      {
        caseKey: "ck_a",
        title: "Case A",
        status: "unchanged_passed",
        configChanged: false,
        evaluationConfigChanged: false,
        scoreDeltas: [],
        base: {
          outcome: "passed",
          iterationIds: ["b1"],
          representativeIterationId: "b1",
          error: null,
        },
        compare: {
          outcome: "passed",
          iterationIds: ["c1"],
          representativeIterationId: "c1",
          error: null,
        },
      },
    ],
    ...overrides,
  };
}

/** Minimal `PlatformApiClient` slice `evaluateBaselineComparison` needs. */
function stubClient(
  compare:
    | PlatformRunCompare
    | (() => Promise<PlatformRunCompare>)
    | { reject: unknown },
) {
  return {
    async compareEvalRun() {
      if (typeof compare === "function") return compare();
      if ("reject" in compare) throw compare.reject;
      return compare;
    },
    async listEvalRunIterations() {
      return { items: [], nextCursor: undefined };
    },
  };
}

test("evaluateBaselineComparison: a real regression evaluates and carries provenance", async () => {
  const result = await evaluateBaselineComparison({
    client: stubClient(compareWire()) as never,
    signal: new AbortController().signal,
    projectId: "proj-alpha",
    runId: "run_compare",
    baseline: "run_base",
    policy: { passRateRegression: {} },
  });
  assert.equal(result.report.outcome, "failed");
  assert.equal(result.provenance?.baseRunId, "run_base");
  assert.equal(result.provenance?.compareRunId, "run_compare");
  const notRecorded = result.provenance?.notRecorded as Record<string, string>;
  assert.equal(notRecorded.modelProvider, "notRecorded");
  assert.equal(notRecorded.hostHarness, "notRecorded");
  assert.equal(notRecorded.serverEnvironmentIdentity, "notRecorded");
  assert.equal(notRecorded.configHashesBeyondEvaluationConfigHash, "notRecorded");
});

test("evaluateBaselineComparison: BASELINE_NOT_FOUND folds to incomplete, never failed", async () => {
  const result = await evaluateBaselineComparison({
    client: stubClient({
      reject: Object.assign(new Error("no baseline"), {
        details: { reason: "BASELINE_NOT_FOUND" },
      }),
    }) as never,
    signal: new AbortController().signal,
    projectId: "proj-alpha",
    runId: "run_compare",
    baseline: "run_base",
    policy: { passRateRegression: {} },
  });
  assert.equal(result.report.outcome, "incomplete");
  assert.equal(result.report.verdicts[0]?.gate, "baseline");
  assert.match(result.report.verdicts[0]?.message ?? "", /no baseline to compare against/);
  assert.equal(result.provenance, undefined);
});

test("evaluateBaselineComparison: an unfinished side is incomplete, defence in depth", async () => {
  const result = await evaluateBaselineComparison({
    client: stubClient(
      compareWire({
        compareRun: { ...compareWire().compareRun, completedAt: null },
      }),
    ) as never,
    signal: new AbortController().signal,
    projectId: "proj-alpha",
    runId: "run_compare",
    baseline: "run_base",
    policy: { passRateRegression: {} },
  });
  assert.equal(result.report.outcome, "incomplete");
  assert.match(
    result.report.verdicts[0]?.message ?? "",
    /must be completed before they can be compared/,
  );
});

test("buildBaselineProvenance: records every evaluated compatibility signal", () => {
  const compare = compareWire();
  const input = {
    base: { iterations: { total: 70, passed: 56 } },
    compare: { iterations: { total: 80, passed: 48 } },
    deterministicScoreRegressions: [],
    scoreDeltasAvailable: false,
    caseSetChanged: true,
    scenarioConfigChanged: false,
    evaluationConfigChanged: true,
    iterationWeightingEqual: false,
  };
  const provenance = buildBaselineProvenance("run_base", compare, input);
  assert.deepEqual(provenance.baseline, compare.baseline);
  assert.deepEqual(provenance.compatibility, {
    caseSetChanged: true,
    scenarioConfigChanged: false,
    evaluationConfigChanged: true,
    iterationWeightingEqual: false,
    baseScoreIntegrity: "valid",
    compareScoreIntegrity: "valid",
  });
});
