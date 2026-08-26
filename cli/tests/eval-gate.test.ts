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
  compareBaseSelector,
  resolveBaselineSelector,
  comparePolicyFromGateOptions,
  evaluateBaselineComparison,
  mergeGateReports,
  policyFromOptions,
  policyNeedsIterations,
  reportForRun,
} from "../src/lib/eval-gate.js";
import { DEFAULT_MIN_EFFECT_SIZE, DEFAULT_MIN_SAMPLE_SIZE } from "@mcpjam/sdk";
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

const RUN_ID = "run-current";
/** The resolved run-id baseline these tests pin, post-flag-resolution. */
const RUN_BASELINE = { kind: "run", runId: "run_base" } as const;

test("assertRunIdBaseline accepts an ordinary run id", () => {
  assert.doesNotThrow(() => assertRunIdBaseline("run_abc123", RUN_ID));
  assert.doesNotThrow(() => assertRunIdBaseline("run-1", RUN_ID));
});

test("assertRunIdBaseline returns the TRIMMED value, not the raw one", () => {
  // Validation checks the trimmed value; forwarding the raw one instead would
  // let a whitespace-padded but otherwise valid `--baseline` slip past every
  // check here and then fail to resolve on the wire (reported as incomplete,
  // exit 3, rather than either working or naming the usage error).
  assert.equal(assertRunIdBaseline("  run-base  ", RUN_ID), "run-base");
  assert.equal(assertRunIdBaseline("run-base", RUN_ID), "run-base");
});

test("assertRunIdBaseline REDIRECTS a 40-hex git SHA to --baseline-sha", () => {
  // No longer "SHA baselines are unsupported" — they are supported, under
  // their own flag. `--baseline` still refuses the shape so a caller who
  // pastes a commit SHA into the run-id flag is told which flag to use,
  // instead of sending a doomed run lookup that comes back as `incomplete`
  // (exit 3) and reads as "no baseline exists".
  const sha = "a".repeat(40);
  assert.throws(
    () => assertRunIdBaseline(sha, RUN_ID),
    /--baseline-sha/,
  );
  assert.throws(
    () => assertRunIdBaseline(sha.toUpperCase(), RUN_ID),
    /--baseline-sha/,
  );
  // One character short or long is not the SHA shape — a real run id could
  // plausibly look like this, so it must NOT be rejected.
  assert.doesNotThrow(() => assertRunIdBaseline("a".repeat(39), RUN_ID));
  assert.doesNotThrow(() => assertRunIdBaseline("a".repeat(41), RUN_ID));
  // Not all-hex: also not the SHA shape.
  assert.doesNotThrow(() => assertRunIdBaseline("g".repeat(40), RUN_ID));
});

test("assertRunIdBaseline rejects a blank value, not just an absent one", () => {
  // Commander cannot tell "--baseline ''" (an unset CI variable interpolated
  // into the flag, e.g. `--baseline "$BASELINE_RUN_ID"`) apart from a real
  // run id — both are `!== undefined`. Downstream, `!options.baseline` and
  // `Boolean(options.baseline)` both read "" as falsy, so an unvalidated
  // blank would silently disable the whole baseline comparison rather than
  // erroring, and the command would exit 0 on nothing the caller asked for.
  for (const blank of ["", "   ", "\t"]) {
    assert.throws(
      () => assertRunIdBaseline(blank, RUN_ID),
      /must not be blank/,
      JSON.stringify(blank),
    );
  }
});

test("assertRunIdBaseline rejects using the gated run as its own baseline", () => {
  // A run compared against itself has identical samples on both sides: the
  // pass-rate delta is zero and no deterministic scorer flips, so the
  // comparative gate would report a clean "no regression" — not because
  // nothing regressed, but because no independent baseline was ever
  // consulted. A CI script that wires the same "latest run" variable into
  // both --run and --baseline (a plausible copy-paste) must not get a green
  // regression gate that validated nothing.
  assert.throws(
    () => assertRunIdBaseline(RUN_ID, RUN_ID),
    /cannot be its own baseline/,
  );
  // A DIFFERENT run id is fine, even one that merely looks similar.
  assert.doesNotThrow(() => assertRunIdBaseline(`${RUN_ID}-2`, RUN_ID));
});

test("assertRunIdBaseline redirects a whitespace-padded SHA, not just a bare one", () => {
  // The SHA check runs against the TRIMMED value: `--baseline " <40-hex> "`
  // is still the wrong flag, and the blank check just above already proved
  // trimming doesn't change what the flag means.
  const padded = `  ${"a".repeat(40)}  `;
  assert.throws(
    () => assertRunIdBaseline(padded, RUN_ID),
    /--baseline-sha/,
  );
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
    baseline: RUN_BASELINE,
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
    baseline: RUN_BASELINE,
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
    baseline: RUN_BASELINE,
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
  const provenance = buildBaselineProvenance(RUN_BASELINE, compare, input, {
    passRateRegression: {},
  });
  assert.deepEqual(provenance.baseline, compare.baseline);
  assert.deepEqual(provenance.compatibility, {
    caseSetChanged: true,
    scenarioConfigChanged: false,
    evaluationConfigChanged: true,
    iterationWeightingEqual: false,
    baseScoreIntegrity: "valid",
    compareScoreIntegrity: "valid",
    // The PINNED CONTRACT names "comparable case ids" explicitly: an
    // archived report's `caseSetChanged: true` alone does not say WHICH
    // cases still measure the same thing, or which ones do not.
    comparableCaseIds: ["ck_a"],
    incompatibleCases: [],
  });
  // The resolved policy that produced this verdict — defaults filled in, so
  // the default case is just as visible as an explicit threshold.
  assert.deepEqual(provenance.policy, {
    passRateRegression: {
      minSampleSize: DEFAULT_MIN_SAMPLE_SIZE,
      minEffectSize: DEFAULT_MIN_EFFECT_SIZE,
    },
    noDeterministicRegressions: false,
    maximumP95LatencyIncreaseMs: null,
  });
});

test("buildBaselineProvenance: an unrequested gate's policy is null, not an implicit default", () => {
  const compare = compareWire();
  const input = {
    base: { iterations: { total: 70, passed: 56 } },
    compare: { iterations: { total: 80, passed: 48 } },
    deterministicScoreRegressions: [],
    scoreDeltasAvailable: false,
    caseSetChanged: false,
    scenarioConfigChanged: false,
    evaluationConfigChanged: false,
    iterationWeightingEqual: true,
  };
  const provenance = buildBaselineProvenance(RUN_BASELINE, compare, input, {});
  assert.deepEqual(provenance.policy, {
    passRateRegression: null,
    noDeterministicRegressions: false,
    maximumP95LatencyIncreaseMs: null,
  });
});

test("buildBaselineProvenance: an explicit policy is echoed back verbatim, not re-defaulted", () => {
  const compare = compareWire();
  const input = {
    base: { iterations: { total: 70, passed: 56 } },
    compare: { iterations: { total: 80, passed: 48 } },
    deterministicScoreRegressions: [],
    scoreDeltasAvailable: false,
    caseSetChanged: false,
    scenarioConfigChanged: false,
    evaluationConfigChanged: false,
    iterationWeightingEqual: true,
  };
  const provenance = buildBaselineProvenance(RUN_BASELINE, compare, input, {
    passRateRegression: { minSampleSize: 20, minEffectSize: 0.05 },
    noDeterministicRegressions: true,
    maximumP95LatencyIncreaseMs: 500,
  });
  assert.deepEqual(provenance.policy, {
    passRateRegression: { minSampleSize: 20, minEffectSize: 0.05 },
    noDeterministicRegressions: true,
    maximumP95LatencyIncreaseMs: 500,
  });
});

test("buildBaselineProvenance: names the added/removed cases behind caseSetChanged", () => {
  const compare = compareWire({
    cases: [
      {
        caseKey: "ck_shared",
        title: "Shared",
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
      {
        caseKey: "ck_new",
        title: "New",
        status: "new_case",
        configChanged: false,
        evaluationConfigChanged: false,
        scoreDeltas: [],
        base: {
          outcome: "absent",
          iterationIds: [],
          representativeIterationId: null,
          error: null,
        },
        compare: {
          outcome: "passed",
          iterationIds: ["c2"],
          representativeIterationId: "c2",
          error: null,
        },
      },
      {
        caseKey: "ck_removed",
        title: "Removed",
        status: "removed_case",
        configChanged: false,
        evaluationConfigChanged: false,
        scoreDeltas: [],
        base: {
          outcome: "passed",
          iterationIds: ["b2"],
          representativeIterationId: "b2",
          error: null,
        },
        compare: {
          outcome: "absent",
          iterationIds: [],
          representativeIterationId: null,
          error: null,
        },
      },
    ],
  });
  const provenance = buildBaselineProvenance(
    RUN_BASELINE,
    compare,
    {
      base: { iterations: { total: 70, passed: 56 } },
      compare: { iterations: { total: 80, passed: 48 } },
      deterministicScoreRegressions: [],
      scoreDeltasAvailable: false,
      caseSetChanged: true,
      scenarioConfigChanged: false,
      evaluationConfigChanged: false,
      iterationWeightingEqual: true,
    },
    {}
  );
  const compatibility = provenance.compatibility as {
    comparableCaseIds: string[];
    incompatibleCases: Array<{
      caseKey: string;
      status: string;
      reasons: string[];
    }>;
  };
  assert.deepEqual(compatibility.comparableCaseIds, ["ck_shared"]);
  assert.deepEqual(compatibility.incompatibleCases, [
    { caseKey: "ck_new", status: "new_case", reasons: ["case_added"] },
    { caseKey: "ck_removed", status: "removed_case", reasons: ["case_removed"] },
  ]);
});

test("buildBaselineProvenance: a case-set-stable case can still be individually incompatible", () => {
  // A case can survive `caseSetChanged` (it exists on both sides) and STILL
  // be the one responsible for `scenarioConfigChanged`,
  // `evaluationConfigChanged`, or unequal iteration weighting.
  // `comparableCaseIds` must not claim a case the whole-run verdict never
  // actually trusted.
  const compare = compareWire({
    cases: [
      {
        caseKey: "ck_clean",
        title: "Clean",
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
      {
        caseKey: "ck_reconfigured",
        title: "Reconfigured",
        status: "changed",
        configChanged: true,
        evaluationConfigChanged: false,
        scoreDeltas: [],
        base: {
          outcome: "passed",
          iterationIds: ["b2"],
          representativeIterationId: "b2",
          error: null,
        },
        compare: {
          outcome: "passed",
          iterationIds: ["c2"],
          representativeIterationId: "c2",
          error: null,
        },
      },
      {
        caseKey: "ck_regraded",
        title: "Regraded",
        status: "unchanged_passed",
        configChanged: false,
        evaluationConfigChanged: true,
        scoreDeltas: [],
        base: {
          outcome: "passed",
          iterationIds: ["b3"],
          representativeIterationId: "b3",
          error: null,
        },
        compare: {
          outcome: "passed",
          iterationIds: ["c3"],
          representativeIterationId: "c3",
          error: null,
        },
      },
      {
        caseKey: "ck_reweighted",
        title: "Reweighted",
        status: "unchanged_passed",
        configChanged: false,
        evaluationConfigChanged: false,
        scoreDeltas: [],
        base: {
          outcome: "passed",
          iterationIds: ["b4"],
          representativeIterationId: "b4",
          error: null,
        },
        compare: {
          outcome: "passed",
          iterationIds: ["c4", "c5"],
          representativeIterationId: "c4",
          error: null,
        },
      },
    ],
  });
  const provenance = buildBaselineProvenance(
    RUN_BASELINE,
    compare,
    {
      base: { iterations: { total: 70, passed: 56 } },
      compare: { iterations: { total: 80, passed: 48 } },
      deterministicScoreRegressions: [],
      scoreDeltasAvailable: false,
      caseSetChanged: false,
      scenarioConfigChanged: true,
      evaluationConfigChanged: true,
      iterationWeightingEqual: false,
    },
    {}
  );
  const compatibility = provenance.compatibility as {
    comparableCaseIds: string[];
    incompatibleCases: Array<{
      caseKey: string;
      status: string;
      reasons: string[];
    }>;
  };
  assert.deepEqual(compatibility.comparableCaseIds, ["ck_clean"]);
  assert.deepEqual(compatibility.incompatibleCases, [
    {
      caseKey: "ck_reconfigured",
      status: "changed",
      reasons: ["scenario_config_changed"],
    },
    {
      caseKey: "ck_regraded",
      status: "unchanged_passed",
      reasons: ["evaluation_config_changed"],
    },
    {
      caseKey: "ck_reweighted",
      status: "unchanged_passed",
      reasons: ["iteration_weighting_unequal"],
    },
  ]);
});

test("buildBaselineProvenance: a run-level evaluation config change excludes every case, even ones whose own row says unchanged", () => {
  // `scoreContract.evaluationConfigChanged` is a RUN-level signal (the
  // evaluation config hash itself changed between runs). A case can still
  // report `evaluationConfigChanged: false` on its own row if the platform
  // only diffs per-case config on things other than the evaluation config
  // hash. The run-level signal must still exclude that case from
  // `comparableCaseIds` — trusting the row-level flag alone would silently
  // compare cases under a config change the run as a whole reports.
  const compare = compareWire({
    scoreContract: {
      base: {
        evaluationConfigHash: "cfg_old",
        scoreIntegrity: "valid",
        scoredIterations: 70,
        quarantinedIterations: 0,
      },
      compare: {
        evaluationConfigHash: "cfg_new",
        scoreIntegrity: "valid",
        scoredIterations: 80,
        quarantinedIterations: 0,
      },
      evaluationConfigChanged: true,
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
  });
  const provenance = buildBaselineProvenance(
    RUN_BASELINE,
    compare,
    {
      base: { iterations: { total: 70, passed: 56 } },
      compare: { iterations: { total: 80, passed: 48 } },
      deterministicScoreRegressions: [],
      scoreDeltasAvailable: false,
      caseSetChanged: false,
      scenarioConfigChanged: false,
      evaluationConfigChanged: true,
      iterationWeightingEqual: true,
    },
    {}
  );
  const compatibility = provenance.compatibility as {
    comparableCaseIds: string[];
    incompatibleCases: Array<{
      caseKey: string;
      status: string;
      reasons: string[];
    }>;
  };
  assert.deepEqual(compatibility.comparableCaseIds, []);
  assert.deepEqual(compatibility.incompatibleCases, [
    {
      caseKey: "ck_a",
      status: "unchanged_passed",
      reasons: ["evaluation_config_changed"],
    },
  ]);
});

// ── --baseline-sha (source-SHA half) ───────────────────────────────────────

const SHA = "9f1a2b3c4d5e6f70819293a4b5c6d7e8f9a0b1c2";

test("resolveBaselineSelector: neither flag is not an error", () => {
  // `--baseline` is optional — a threshold-only gate is a legitimate
  // invocation and must not be forced to name a baseline it never wanted.
  assert.equal(resolveBaselineSelector({ runId: RUN_ID }), undefined);
});

test("resolveBaselineSelector: names the KIND rather than inferring it", () => {
  assert.deepEqual(resolveBaselineSelector({ baseline: "run_base", runId: RUN_ID }), {
    kind: "run",
    runId: "run_base",
  });
  assert.deepEqual(resolveBaselineSelector({ baselineSha: SHA, runId: RUN_ID }), {
    kind: "commitSha",
    commitSha: SHA,
  });
});

test("resolveBaselineSelector: the two flags are mutually exclusive", () => {
  // Refused HERE, before any request. The v1 route and the Convex action
  // refuse the same pair; none of the three is allowed to win silently by
  // picking one, because a baseline that resolves the way the caller did not
  // ask for is a verdict computed against the wrong run.
  assert.throws(
    () =>
      resolveBaselineSelector({
        baseline: "run_base",
        baselineSha: SHA,
        runId: RUN_ID,
      }),
    /mutually exclusive/,
  );
});

test("resolveBaselineSelector: --baseline-sha is TRIMMED, like --baseline", () => {
  // Same failure mode the run-id half already guards: a padded value that
  // passed validation but travelled raw would be refused on the wire, or
  // resolve to nothing and report `incomplete` (exit 3) — a comparability
  // answer for what is really a usage error.
  assert.deepEqual(
    resolveBaselineSelector({ baselineSha: `  ${SHA}  `, runId: RUN_ID }),
    { kind: "commitSha", commitSha: SHA },
  );
});

test("resolveBaselineSelector: a blank --baseline-sha is a usage error", () => {
  // `--baseline-sha "$GITHUB_SHA"` with the variable unset hands Commander an
  // empty string: `!== undefined` but falsy, so unchecked it would silently
  // disable the whole comparison and exit 0 on nothing the caller asked for.
  for (const blank of ["", "   ", "\t"]) {
    assert.throws(
      () => resolveBaselineSelector({ baselineSha: blank, runId: RUN_ID }),
      /must not be blank/,
      JSON.stringify(blank),
    );
  }
});

test("resolveBaselineSelector: a SHA is NOT validated for shape", () => {
  // Deliberate. SHAs are matched byte-for-byte as CI reported them, so a
  // client-side shape rule would veto a source identifier the backend would
  // have resolved — an abbreviated SHA being the obvious case.
  assert.deepEqual(resolveBaselineSelector({ baselineSha: "9f1a2b3", runId: RUN_ID }), {
    kind: "commitSha",
    commitSha: "9f1a2b3",
  });
});

test("comparePolicyFromGateOptions: --baseline-sha enables the regression gate", () => {
  // Reading only `baseline` here would make every comparative flag silently
  // inert under `--baseline-sha`.
  const policy = comparePolicyFromGateOptions({ baselineSha: SHA });
  assert.ok(policy.passRateRegression, "SHA baseline must enable the gate");
  assert.doesNotThrow(() =>
    comparePolicyFromGateOptions({
      baselineSha: SHA,
      gateDeterministicRegressions: true,
    }),
  );
});

test("comparePolicyFromGateOptions: tuning flags still need SOME baseline", () => {
  assert.throws(
    () => comparePolicyFromGateOptions({ gateDeterministicRegressions: true }),
    /--baseline or --baseline-sha/,
  );
});

test("evaluateBaselineComparison: a SHA baseline sends baseCommitSha, not baseRunId", async () => {
  let sent: Record<string, unknown> | undefined;
  const client = {
    async compareEvalRun(params: Record<string, unknown>) {
      sent = params;
      return compareWire({
        baseline: {
          policy: "commit_sha",
          baseRunId: "run_base",
          baseCommitSha: SHA,
        },
      });
    },
    async listEvalRunIterations() {
      return { items: [], nextCursor: undefined };
    },
  };
  const result = await evaluateBaselineComparison({
    client: client as never,
    signal: new AbortController().signal,
    projectId: "proj-alpha",
    runId: "run_compare",
    baseline: { kind: "commitSha", commitSha: SHA },
    policy: { passRateRegression: {} },
  });

  // Exactly one selector on the wire.
  assert.equal(sent?.baseCommitSha, SHA);
  assert.equal(sent?.baseRunId, undefined);

  // The pin requires a gate to record baseline run id AND source SHA. Keeping
  // only one loses the audit trail: the SHA is what CI asked for, the run id
  // is what the verdict was actually computed against.
  assert.equal(result.provenance?.requestedBaselineKind, "commitSha");
  assert.equal(result.provenance?.requestedBaselineCommitSha, SHA);
  assert.equal(result.provenance?.resolvedBaselineCommitSha, SHA);
  assert.equal(result.provenance?.baseRunId, "run_base");
});

test("provenance: an absent matchCount records uniqueness, and invents no count", async () => {
  const provenance = buildBaselineProvenance(
    { kind: "commitSha", commitSha: SHA },
    compareWire({
      baseline: { policy: "commit_sha", baseRunId: "run_base", baseCommitSha: SHA },
    }),
    {
      base: { iterations: { total: 70, passed: 56 } },
      compare: { iterations: { total: 80, passed: 48 } },
      deterministicScoreRegressions: [],
      scoreDeltasAvailable: false,
      caseSetChanged: false,
      scenarioConfigChanged: false,
      evaluationConfigChanged: false,
      iterationWeightingEqual: true,
    },
    {},
  );
  assert.equal(provenance.baselineMatchUnique, true);
  // Absent means unambiguous — it must NOT be defaulted to 1, which would
  // read as a count the backend actually reported.
  assert.equal(provenance.baselineMatchCount, undefined);
});

test("provenance: an AMBIGUOUS match is recorded, not silently compared", async () => {
  const provenance = buildBaselineProvenance(
    { kind: "commitSha", commitSha: SHA },
    compareWire({
      baseline: {
        policy: "commit_sha",
        baseRunId: "run_base",
        baseCommitSha: SHA,
        matchCount: 3,
      },
    }),
    {
      base: { iterations: { total: 70, passed: 56 } },
      compare: { iterations: { total: 80, passed: 48 } },
      deterministicScoreRegressions: [],
      scoreDeltasAvailable: false,
      caseSetChanged: false,
      scenarioConfigChanged: false,
      evaluationConfigChanged: false,
      iterationWeightingEqual: true,
    },
    {},
  );
  assert.equal(provenance.baselineMatchCount, 3);
  assert.equal(provenance.baselineMatchUnique, false);
  assert.equal(provenance.baselineMatchCountTruncated, false);
});

test("provenance: matchCount 1 + truncated is NOT recorded as unique", async () => {
  // The case the flag exists for. A floor of 1 is not a proof of 1: older
  // eligible runs may exist beyond the bounded lookup. Recording this as
  // unique would be a false claim — and a regression verdict rests on it.
  const provenance = buildBaselineProvenance(
    { kind: "commitSha", commitSha: SHA },
    compareWire({
      baseline: {
        policy: "commit_sha",
        baseRunId: "run_base",
        baseCommitSha: SHA,
        matchCount: 1,
        matchCountTruncated: true,
      },
    }),
    {
      base: { iterations: { total: 70, passed: 56 } },
      compare: { iterations: { total: 80, passed: 48 } },
      deterministicScoreRegressions: [],
      scoreDeltasAvailable: false,
      caseSetChanged: false,
      scenarioConfigChanged: false,
      evaluationConfigChanged: false,
      iterationWeightingEqual: true,
    },
    {},
  );
  assert.equal(provenance.baselineMatchCount, 1);
  assert.equal(provenance.baselineMatchCountTruncated, true);
  assert.equal(
    provenance.baselineMatchUnique,
    false,
    "a truncated count of 1 must never be recorded as an established unique match",
  );
});

test("an UNRESOLVABLE SHA is incomplete (exit 3), never a regression (exit 1)", async () => {
  const result = await evaluateBaselineComparison({
    client: stubClient({
      reject: Object.assign(new Error("no run for that commit"), {
        details: { reason: "BASELINE_NOT_FOUND" },
      }),
    }) as never,
    signal: new AbortController().signal,
    projectId: "proj-alpha",
    runId: "run_compare",
    baseline: { kind: "commitSha", commitSha: SHA },
    policy: { passRateRegression: {} },
  });
  assert.equal(result.report.outcome, "incomplete");
  assert.equal(result.report.verdicts[0]?.status, "non_gateable");
  assert.equal(evalGateExitCode(result.report), EVAL_GATE_INCOMPLETE_EXIT_CODE);
  assert.notEqual(evalGateExitCode(result.report), 1);
});

test("compareBaseSelector: eval compare refuses the pair but allows NEITHER", () => {
  // `eval compare` differs from `eval gate` in exactly one way: omitting both
  // is its documented default (nearest earlier completed run), not an error.
  assert.deepEqual(compareBaseSelector({}), {});
  assert.deepEqual(compareBaseSelector({ baseRun: " run_base " }), {
    baseRunId: "run_base",
  });
  assert.deepEqual(compareBaseSelector({ baseSha: ` ${SHA} ` }), {
    baseCommitSha: SHA,
  });
  assert.throws(
    () => compareBaseSelector({ baseRun: "run_base", baseSha: SHA }),
    /mutually exclusive/,
  );
});
