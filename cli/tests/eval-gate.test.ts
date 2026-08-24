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
  policyFromOptions,
  policyNeedsIterations,
  reportForRun,
} from "../src/lib/eval-gate.js";
import type { GateReport } from "@mcpjam/sdk";

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
