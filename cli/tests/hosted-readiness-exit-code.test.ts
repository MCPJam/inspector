/**
 * The hosted verdict, and the one code a local run can never produce.
 *
 * `directoryReadinessExitCode` grades an SDK RESULT. A hosted run is a ROW,
 * with two extra things a result does not have: a lifecycle that can end
 * somewhere other than "completed", and an observation axis that is
 * independent of the grade. Both have to be read without letting either
 * contaminate the other.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  directoryReadinessExitCode,
  hostedReadinessExitCode,
  READINESS_EXIT_OBSERVATIONS_UNAVAILABLE,
} from "../src/lib/directory-readiness-exit-code.js";

test("a run that did not complete is 3, never 1", () => {
  // The rule the local module already sets: no infrastructure condition may
  // map to 1, because none of them is a statement about the target. A failed
  // run can still carry lanes from an earlier attempt, so reading its verdict
  // would present a partial grade as a whole one.
  for (const status of ["failed", "cancelled", "pending", "running"]) {
    assert.equal(
      hostedReadinessExitCode({ status, overallStatus: "ready" }),
      3,
      `${status} must not be reported as a verdict`,
    );
  }
});

test("a completed run grades exactly as its local twin does", () => {
  assert.equal(
    hostedReadinessExitCode({ status: "completed", overallStatus: "ready" }),
    directoryReadinessExitCode({ status: "ready" }),
  );
  assert.equal(
    hostedReadinessExitCode({
      status: "completed",
      overallStatus: "not-ready",
    }),
    directoryReadinessExitCode({ status: "not-ready" }),
  );
  assert.equal(
    hostedReadinessExitCode({
      status: "completed",
      overallStatus: "incomplete",
    }),
    directoryReadinessExitCode({ status: "incomplete" }),
  );
  // A completed run with no rollup established nothing.
  assert.equal(
    hostedReadinessExitCode({ status: "completed", overallStatus: null }),
    3,
  );
});

test("a refused observation lowers a PASS and nothing else", () => {
  // Non-dispositive by construction: a credit refusal must not turn a passing
  // server into a failing one for a billing reason.
  assert.equal(
    hostedReadinessExitCode({
      status: "completed",
      overallStatus: "ready",
      includeLlmObservations: true,
      llmObservations: { status: "billing-blocked" },
    }),
    READINESS_EXIT_OBSERVATIONS_UNAVAILABLE,
  );

  // A real verdict always outranks a missing opinion.
  for (const [overallStatus, expected] of [
    ["not-ready", 1],
    ["incomplete", 3],
  ] as const) {
    assert.equal(
      hostedReadinessExitCode({
        status: "completed",
        overallStatus,
        includeLlmObservations: true,
        llmObservations: { status: "provider-failed" },
      }),
      expected,
    );
  }
});

test("observations nobody asked for cannot lower anything", () => {
  // Every free run carries `not-requested` forever. Reading that as an
  // unfulfilled request would fail all of them.
  assert.equal(
    hostedReadinessExitCode({
      status: "completed",
      overallStatus: "ready",
      includeLlmObservations: false,
      llmObservations: { status: "not-requested" },
    }),
    0,
  );
  // Asked for AND delivered.
  assert.equal(
    hostedReadinessExitCode({
      status: "completed",
      overallStatus: "ready",
      includeLlmObservations: true,
      llmObservations: { status: "completed" },
    }),
    0,
  );
});

test("an ABSENT observation state counts as not-produced", () => {
  // A row from a backend that predates the field carries no observation state
  // at all. Reading that silence as success would exit 0 for a caller who
  // asked for commentary and received none.
  assert.equal(
    hostedReadinessExitCode({
      status: "completed",
      overallStatus: "ready",
      includeLlmObservations: true,
    }),
    READINESS_EXIT_OBSERVATIONS_UNAVAILABLE,
  );
  // And still nothing when nobody asked.
  assert.equal(
    hostedReadinessExitCode({
      status: "completed",
      overallStatus: "ready",
      includeLlmObservations: false,
    }),
    0,
  );
});

test("2 and 4 are never produced by a verdict", () => {
  // 2 is reserved CLI-wide for usage errors: a broken command line has to stay
  // distinguishable from a graded server. 4 is deliberately absent — a failed
  // run is an infrastructure condition, and those are 3.
  const codes = new Set<number>();
  for (const status of ["completed", "failed", "cancelled", "pending"]) {
    for (const overallStatus of ["ready", "not-ready", "incomplete", null]) {
      for (const includeLlmObservations of [true, false]) {
        for (const observation of [
          "not-requested",
          "completed",
          "billing-blocked",
          "provider-failed",
          "invalid-output",
        ]) {
          codes.add(
            hostedReadinessExitCode({
              status,
              overallStatus,
              includeLlmObservations,
              llmObservations: { status: observation },
            }),
          );
        }
      }
    }
  }
  assert.ok(!codes.has(2), `2 was produced by a verdict: ${[...codes]}`);
  assert.ok(!codes.has(4), `4 was produced by a verdict: ${[...codes]}`);
});
