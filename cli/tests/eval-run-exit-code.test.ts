/**
 * The exit-code matrix for `mcpjam cloud eval run --wait`.
 *
 * Table-driven over the three pure functions in `eval-run-exit-code.ts`:
 * `classifyLaunchErrorExitCode`, `classifyWaitErrorExitCode`, and the
 * worst-of merge `evalRunWaitExitCode`. The end-to-end wiring (real launch
 * failures, real mid-poll 401s, real fan-out merges through the actual CLI
 * action) is pinned separately in `eval.test.ts` — these are the pure-
 * function contract in isolation, including the full severity matrix.
 *
 * The rule that matters most, copied from `eval-gate-exit-code.test.ts`'s
 * sibling suites: NO infrastructure condition maps to 1. Nothing but a
 * `status: "completed"`, `result: "failed"` run may ever produce exit 1.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyLaunchErrorExitCode,
  classifyWaitErrorExitCode,
  evalRunWaitExitCode,
  type EvalRunWaitErrorSummary,
  type EvalRunWaitRunOutcome,
} from "../src/lib/eval-run-exit-code.js";

function run(
  overrides: Partial<EvalRunWaitRunOutcome> = {}
): EvalRunWaitRunOutcome {
  return { status: "completed", result: "passed", ...overrides };
}

function waitError(
  overrides: Partial<EvalRunWaitErrorSummary> = {}
): EvalRunWaitErrorSummary {
  return { runId: "run-x", ...overrides };
}

// ---------------------------------------------------------------------------
// classifyLaunchErrorExitCode
// ---------------------------------------------------------------------------

test("classifyLaunchErrorExitCode — auth-shaped codes -> 3", () => {
  for (const code of ["UNAUTHORIZED", "FORBIDDEN", "OAUTH_REQUIRED"]) {
    assert.equal(classifyLaunchErrorExitCode(code), 3, code);
  }
});

test("classifyLaunchErrorExitCode — invalid-shaped codes -> 2", () => {
  for (const code of [
    "VALIDATION_ERROR",
    "NOT_FOUND",
    "CONFLICT",
    "UNSUPPORTED",
  ]) {
    assert.equal(classifyLaunchErrorExitCode(code), 2, code);
  }
});

test("classifyLaunchErrorExitCode — everything else fails toward infra (4)", () => {
  for (const code of [
    "NETWORK_ERROR",
    "TIMEOUT",
    "SERVER_UNREACHABLE",
    "RATE_LIMITED",
    "INTERNAL_ERROR",
    // The v1 API's real lowercase vocabulary — never auth-shaped, never
    // invalid-shaped. See the "billing_limit_reached -> 4" doc block.
    "billing_limit_reached",
    // A code this CLI has never seen at all.
    "SOME_FUTURE_CODE",
    undefined,
  ]) {
    assert.equal(classifyLaunchErrorExitCode(code), 4, String(code));
  }
});

test("classifyLaunchErrorExitCode — a billing failure disguised as FORBIDDEN still reads as 4", () => {
  // The v1 API's public error union has no billing member, so the server
  // collapses BILLING_LIMIT_REACHED onto the wire code FORBIDDEN
  // (routes/v1/envelope.ts's mapInternalCode) — the same wire code a real
  // credential rejection carries. The original reason survives in
  // details.code, and must win over the auth-shaped classification.
  for (const detailCode of ["billing_limit_reached", "billing_feature_not_included"]) {
    assert.equal(
      classifyLaunchErrorExitCode("FORBIDDEN", { code: detailCode }),
      4,
      detailCode,
    );
  }
});

test("classifyLaunchErrorExitCode — a real FORBIDDEN with no billing detail stays auth-shaped (3)", () => {
  assert.equal(classifyLaunchErrorExitCode("FORBIDDEN"), 3);
  assert.equal(classifyLaunchErrorExitCode("FORBIDDEN", { code: "OTHER_REASON" }), 3);
  assert.equal(classifyLaunchErrorExitCode("FORBIDDEN", null), 3);
  assert.equal(classifyLaunchErrorExitCode("FORBIDDEN", "not-an-object"), 3);
});

// ---------------------------------------------------------------------------
// classifyWaitErrorExitCode
// ---------------------------------------------------------------------------

test("classifyWaitErrorExitCode — auth-shaped codes -> 3, mid-wait too", () => {
  for (const code of ["UNAUTHORIZED", "FORBIDDEN", "OAUTH_REQUIRED"]) {
    assert.equal(classifyWaitErrorExitCode(code), 3, code);
  }
});

test("classifyWaitErrorExitCode — everything else is 'no valid verdict observed' (5)", () => {
  for (const code of [
    "NETWORK_ERROR",
    "TIMEOUT",
    "OPERATIONAL_ERROR", // a deadline timeout's own CliError code
    "SOME_FUTURE_CODE",
    undefined,
  ]) {
    assert.equal(classifyWaitErrorExitCode(code), 5, String(code));
  }
});

// ---------------------------------------------------------------------------
// evalRunWaitExitCode — single-run mapping
// ---------------------------------------------------------------------------

test("0 — a single completed, passed run, launch started", () => {
  assert.equal(
    evalRunWaitExitCode({
      launchOutcome: "started",
      runs: [run({ result: "passed" })],
      waitErrors: [],
    }),
    0
  );
});

test("1 — THE ONLY producer: status completed, result failed", () => {
  assert.equal(
    evalRunWaitExitCode({
      launchOutcome: "started",
      runs: [run({ status: "completed", result: "failed" })],
      waitErrors: [],
    }),
    1
  );
});

test("5 — result: inconclusive is never a pass and never a failure", () => {
  assert.equal(
    evalRunWaitExitCode({
      launchOutcome: "started",
      runs: [run({ result: "inconclusive" })],
      waitErrors: [],
    }),
    5
  );
});

test("5 — result: null (or any unrecognized value) fails closed", () => {
  for (const result of [null, undefined, "some-future-verdict"]) {
    assert.equal(
      evalRunWaitExitCode({
        launchOutcome: "started",
        runs: [run({ result })],
        waitErrors: [],
      }),
      5,
      String(result)
    );
  }
});

test("5, not 1 — a run still HELD for its judge has produced no verdict", () => {
  // `grading` never reaches a terminal set, so a `--wait` that runs out on it
  // lands here as "no valid verdict observed". Reporting a judge that has not
  // answered as a regression (1) is the one thing this contract forbids.
  assert.equal(
    evalRunWaitExitCode({
      launchOutcome: "started",
      runs: [run({ status: "grading", result: "pending" })],
      waitErrors: [],
    }),
    5
  );
});

test("5, not 4 — status: failed is an execution crash, not a setup defect", () => {
  assert.equal(
    evalRunWaitExitCode({
      launchOutcome: "started",
      // A non-verdict STATUS wins over whatever `result` happens to carry —
      // the CLI cannot distinguish "setup aborted" from "crashed mid-run".
      runs: [run({ status: "failed", result: "failed" })],
      waitErrors: [],
    }),
    5
  );
});

test("5 — status: cancelled / timed_out are both non-verdict", () => {
  for (const status of ["cancelled", "timed_out"]) {
    assert.equal(
      evalRunWaitExitCode({
        launchOutcome: "started",
        runs: [run({ status, result: "passed" })],
        waitErrors: [],
      }),
      5,
      status
    );
  }
});

test("5 — a reporting failure on an otherwise-passed run", () => {
  assert.equal(
    evalRunWaitExitCode({
      launchOutcome: "started",
      runs: [run({ result: "passed", reportingFailed: true })],
      waitErrors: [],
    }),
    5
  );
});

test("1, not 5 — a reporting failure never masks a real verdict failure", () => {
  assert.equal(
    evalRunWaitExitCode({
      launchOutcome: "started",
      runs: [run({ result: "failed", reportingFailed: true })],
      waitErrors: [],
    }),
    1
  );
});

test("no reportingFailed set at all is the same as false", () => {
  assert.equal(
    evalRunWaitExitCode({
      launchOutcome: "started",
      runs: [run({ result: "passed" })],
      waitErrors: [],
    }),
    0
  );
});

// ---------------------------------------------------------------------------
// evalRunWaitExitCode — launch outcome and wait errors
// ---------------------------------------------------------------------------

test("4 — a partial fan-out is a flat contribution, regardless of the failed target's reason", () => {
  assert.equal(
    evalRunWaitExitCode({
      launchOutcome: "partial",
      runs: [run({ result: "passed" })],
      waitErrors: [],
    }),
    4
  );
});

test("4 — a total fan-out failure (zero started)", () => {
  assert.equal(
    evalRunWaitExitCode({ launchOutcome: "failed", runs: [], waitErrors: [] }),
    4
  );
});

test("3 — a wait error with an auth-shaped code", () => {
  assert.equal(
    evalRunWaitExitCode({
      launchOutcome: "started",
      runs: [],
      waitErrors: [waitError({ errorCode: "UNAUTHORIZED" })],
    }),
    3
  );
});

test("5 — a wait error with no code (a deadline timeout) or a non-auth code", () => {
  for (const errorCode of [undefined, "NETWORK_ERROR", "TIMEOUT"]) {
    assert.equal(
      evalRunWaitExitCode({
        launchOutcome: "started",
        runs: [],
        waitErrors: [waitError({ errorCode })],
      }),
      5,
      String(errorCode)
    );
  }
});

test("0 — started launch, zero runs, zero wait errors defaults to pass", () => {
  // Not a state the real command produces, but the merge must fail toward
  // the least surprising answer rather than throw on an empty input.
  assert.equal(
    evalRunWaitExitCode({ launchOutcome: "started", runs: [], waitErrors: [] }),
    0
  );
});

// ---------------------------------------------------------------------------
// evalRunWaitExitCode — the severity matrix: 1 > 3 > 4 > 5 > 0
// ---------------------------------------------------------------------------

test("severity: 1 beats every other code, in every combination", () => {
  const oneFailed = run({ result: "failed" });
  const cases: Array<{
    label: string;
    runs: EvalRunWaitRunOutcome[];
    waitErrors: EvalRunWaitErrorSummary[];
    launchOutcome: "started" | "partial" | "failed";
  }> = [
    {
      label: "1 vs 3",
      launchOutcome: "started",
      runs: [oneFailed],
      waitErrors: [waitError({ errorCode: "UNAUTHORIZED" })],
    },
    {
      label: "1 vs 4",
      launchOutcome: "partial",
      runs: [oneFailed],
      waitErrors: [],
    },
    {
      label: "1 vs 5",
      launchOutcome: "started",
      runs: [oneFailed, run({ result: "inconclusive" })],
      waitErrors: [],
    },
    {
      label: "1 vs 3, 4, 5 all at once",
      launchOutcome: "partial",
      runs: [oneFailed, run({ result: "inconclusive" })],
      waitErrors: [waitError({ errorCode: "FORBIDDEN" })],
    },
  ];
  for (const { label, ...input } of cases) {
    assert.equal(evalRunWaitExitCode(input), 1, label);
  }
});

test("severity: 3 beats 4 and 5 when no run failed", () => {
  const cases: Array<{
    label: string;
    runs: EvalRunWaitRunOutcome[];
    waitErrors: EvalRunWaitErrorSummary[];
    launchOutcome: "started" | "partial" | "failed";
  }> = [
    {
      label: "3 vs 4",
      launchOutcome: "partial",
      runs: [run({ result: "passed" })],
      waitErrors: [waitError({ errorCode: "OAUTH_REQUIRED" })],
    },
    {
      label: "3 vs 5",
      launchOutcome: "started",
      runs: [run({ result: "inconclusive" })],
      waitErrors: [waitError({ errorCode: "UNAUTHORIZED" })],
    },
    {
      label: "3 vs 4 and 5 at once",
      launchOutcome: "partial",
      runs: [run({ result: "inconclusive" })],
      waitErrors: [waitError({ errorCode: "FORBIDDEN" })],
    },
  ];
  for (const { label, ...input } of cases) {
    assert.equal(evalRunWaitExitCode(input), 3, label);
  }
});

test("severity: 4 beats 5 when nothing worse is present", () => {
  assert.equal(
    evalRunWaitExitCode({
      launchOutcome: "partial",
      runs: [run({ result: "inconclusive" })],
      waitErrors: [waitError({ errorCode: "NETWORK_ERROR" })],
    }),
    4
  );
});

test("severity: 0 only when every code present is 0", () => {
  assert.equal(
    evalRunWaitExitCode({
      launchOutcome: "started",
      runs: [run({ result: "passed" }), run({ result: "passed" })],
      waitErrors: [],
    }),
    0
  );
});

test("severity: a single non-zero code anywhere rules out 0", () => {
  assert.equal(
    evalRunWaitExitCode({
      launchOutcome: "started",
      runs: [
        run({ result: "passed" }),
        run({ result: "passed" }),
        run({ reportingFailed: true }),
      ],
      waitErrors: [],
    }),
    5
  );
});
