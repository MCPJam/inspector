import assert from "node:assert/strict";
import test from "node:test";
import {
  EVAL_GATE_INCOMPLETE_EXIT_CODE,
  EVAL_GATE_USAGE_EXIT_CODE,
  evalGateExitCode,
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

test("cancelled and timed-out runs establish no verdict", () => {
  assert.equal(isNonVerdictRunStatus("cancelled"), true);
  assert.equal(isNonVerdictRunStatus("timed_out"), true);
  // A genuinely failed run DID establish one.
  assert.equal(isNonVerdictRunStatus("failed"), false);
  assert.equal(isNonVerdictRunStatus("completed"), false);
  assert.equal(isNonVerdictRunStatus(undefined), false);
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
