import assert from "node:assert/strict";
import test from "node:test";
import {
  describeReadinessExit,
  readinessExitCode,
  READINESS_EXIT_EXECUTION_FAILED,
  READINESS_EXIT_INCOMPLETE,
  READINESS_EXIT_NOT_READY,
  READINESS_EXIT_OBSERVATIONS_UNAVAILABLE,
  READINESS_EXIT_READY,
} from "../src/lib/readiness-exit-code.js";

test("incomplete gets its own code — it is not a pass and not a violation", () => {
  // The whole reason readiness has a third state. A CI job that went green
  // because the run could not reach the server would tell its owner the
  // opposite of the truth.
  assert.equal(
    readinessExitCode({ overallStatus: "incomplete", runStatus: "completed" }),
    READINESS_EXIT_INCOMPLETE,
  );
  assert.equal(
    readinessExitCode({ overallStatus: "not-ready", runStatus: "completed" }),
    READINESS_EXIT_NOT_READY,
  );
  assert.equal(
    readinessExitCode({ overallStatus: "ready", runStatus: "completed" }),
    READINESS_EXIT_READY,
  );
});

test("a run that never finished reports execution failure, not a verdict", () => {
  // A failed hosted run can still carry lanes from an earlier attempt.
  // Reporting them would present a partial grade as a whole one.
  for (const runStatus of [
    "failed",
    "cancelled",
    "pending",
    "running",
  ] as const) {
    assert.equal(
      readinessExitCode({ overallStatus: "ready", runStatus }),
      READINESS_EXIT_EXECUTION_FAILED,
      `${runStatus} must not be reported as a verdict`,
    );
  }
  assert.equal(
    readinessExitCode({ overallStatus: null, runStatus: "completed" }),
    READINESS_EXIT_EXECUTION_FAILED,
  );
});

test("a refused observation lowers a PASS, and never touches a failure", () => {
  // Observations are non-dispositive by construction, so a credit refusal must
  // not turn a passing server into a failing one for a billing reason. But a
  // caller that asked for commentary and did not get it did not get what it
  // asked for, and a silent 0 hides that.
  assert.equal(
    readinessExitCode({
      overallStatus: "ready",
      runStatus: "completed",
      requestedObservations: true,
      observationStatus: "billing-blocked",
    }),
    READINESS_EXIT_OBSERVATIONS_UNAVAILABLE,
  );

  // A real verdict always outranks a missing opinion.
  assert.equal(
    readinessExitCode({
      overallStatus: "not-ready",
      runStatus: "completed",
      requestedObservations: true,
      observationStatus: "billing-blocked",
    }),
    READINESS_EXIT_NOT_READY,
  );
  assert.equal(
    readinessExitCode({
      overallStatus: "incomplete",
      runStatus: "completed",
      requestedObservations: true,
      observationStatus: "provider-failed",
    }),
    READINESS_EXIT_INCOMPLETE,
  );
});

test("observations nobody asked for cannot lower anything", () => {
  // `not-requested` is the default state of every run that did not opt in.
  // Reading it as an unfulfilled request would fail every free run.
  assert.equal(
    readinessExitCode({
      overallStatus: "ready",
      runStatus: "completed",
      requestedObservations: false,
      observationStatus: "not-requested",
    }),
    READINESS_EXIT_READY,
  );
  // Asked for AND delivered.
  assert.equal(
    readinessExitCode({
      overallStatus: "ready",
      runStatus: "completed",
      requestedObservations: true,
      observationStatus: "completed",
    }),
    READINESS_EXIT_READY,
  );
});

test("2 is never produced here — it belongs to usage errors", () => {
  // The CLI reserves 2 for a malformed invocation. A readiness verdict that
  // collided with it would make a broken command line indistinguishable from
  // a graded server.
  const codes = new Set<number>();
  for (const overallStatus of ["ready", "not-ready", "incomplete"] as const) {
    for (const requestedObservations of [true, false]) {
      for (const observationStatus of [
        "not-requested",
        "completed",
        "billing-blocked",
        "provider-failed",
        "invalid-output",
      ] as const) {
        codes.add(
          readinessExitCode({
            overallStatus,
            runStatus: "completed",
            requestedObservations,
            observationStatus,
          }),
        );
      }
    }
  }
  assert.ok(!codes.has(2), `2 was produced by a verdict: ${[...codes]}`);
});

test("the explanation names the failing lanes rather than just the status", () => {
  // "Not ready" with no subject is a status, not a next step.
  const message = describeReadinessExit(
    READINESS_EXIT_NOT_READY,
    "directory-policy, submission-artifacts",
  );
  assert.match(String(message), /directory-policy/);
  assert.match(String(message), /submission-artifacts/);

  const incomplete = describeReadinessExit(READINESS_EXIT_INCOMPLETE);
  assert.match(String(incomplete), /NOT a pass/);

  // A refused observation must say the grade still stands, or a reader will
  // assume the server is the problem.
  const blocked = describeReadinessExit(
    READINESS_EXIT_OBSERVATIONS_UNAVAILABLE,
  );
  assert.match(String(blocked), /complete and unaffected/);

  assert.equal(describeReadinessExit(READINESS_EXIT_READY), undefined);
});
