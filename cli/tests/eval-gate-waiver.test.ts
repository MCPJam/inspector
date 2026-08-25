/**
 * `mcpjam cloud eval gate` and its waiver subcommands (Evals v2, step E5b).
 *
 * The CLI owns the word "visible" in the Lane E charter. The platform already
 * refuses to make a waiver permanent and already puts it on the GitHub Check
 * Run; what could still go wrong HERE is the failure a green test suite hides
 * best — an exit code that flips from 1 to 0 with nothing in any artifact
 * saying why.
 *
 * So these tests are mostly not about the exit code. They are about what the
 * command REFUSES to waive, and about the waiver surviving the trip from the
 * run projection into a report.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  EVAL_GATE_INCOMPLETE_EXIT_CODE,
  evalGateExitCode,
} from "../src/lib/eval-gate-exit-code.js";
import {
  activeWaiverForRun,
  mergeGateReports,
  parseWaiverExpiry,
} from "../src/lib/eval-gate.js";
import { applyGateWaiver } from "@mcpjam/sdk";
import type { GateReport, GateWaiver } from "@mcpjam/sdk";
import type { PlatformEvalRun } from "@mcpjam/sdk/platform";

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

function run(gateWaiver: PlatformEvalRun["gateWaiver"]): PlatformEvalRun {
  return {
    id: "run_1",
    suiteId: "suite_1",
    runNumber: 1,
    status: "completed",
    result: "failed",
    summary: { total: 10, passed: 5, failed: 5 },
    source: "api",
    notes: null,
    createdAt: NOW - DAY,
    completedAt: NOW - DAY / 2,
    gateWaiver,
  };
}

function waiverRow(
  overrides: Partial<NonNullable<PlatformEvalRun["gateWaiver"]>> = {}
) {
  return {
    id: "wv_1",
    suiteId: "suite_1",
    runId: "run_1",
    reason: "hotfix ships today; tracked in ENG-1",
    expiresAt: NOW + DAY,
    createdAt: NOW - DAY,
    createdBy: "usr_1",
    createdByEmail: "alice@example.com",
    revokedAt: null,
    revokedBy: null,
    active: true,
    policySnapshot: { minimumPassRate: 100 },
    ...overrides,
  };
}

const failed: GateReport = {
  outcome: "failed",
  scoreIntegrity: "valid",
  verdicts: [
    { gate: "minimumPassRate", status: "failed", message: "pass rate 0.500" },
  ],
};

// ── The four exit codes are UNCHANGED ───────────────────────────────────────

test("`waived` exits 0, and the other four codes keep their meanings", () => {
  const report = (outcome: GateReport["outcome"]): GateReport => ({
    outcome,
    verdicts: [],
    scoreIntegrity: "unknown",
  });
  assert.equal(evalGateExitCode(report("passed")), 0);
  assert.equal(evalGateExitCode(report("waived")), 0);
  assert.equal(evalGateExitCode(report("failed")), 1);
  assert.equal(evalGateExitCode(report("usage_error")), 2);
  assert.equal(evalGateExitCode(report("incomplete")), 3);
});

// ── What the CLI refuses to waive ───────────────────────────────────────────

test("a waiver never converts an INFRASTRUCTURE outcome into a pass", () => {
  // The fail-open case. A waiver granted because the evals regressed is not
  // consent to ship on a cancelled run, a wait timeout, or a flaked fetch —
  // and each of those arrives as `incomplete`.
  const incomplete: GateReport = {
    outcome: "incomplete",
    scoreIntegrity: "unknown",
    verdicts: [
      { gate: "run", status: "non_gateable", message: "run is cancelled" },
    ],
  };
  const waived = applyGateWaiver(
    incomplete,
    activeWaiverForRun(run(waiverRow()), NOW),
    NOW
  );
  assert.equal(waived.outcome, "incomplete");
  assert.equal(evalGateExitCode(waived), EVAL_GATE_INCOMPLETE_EXIT_CODE);
  // The waiver is still ON the report, so the artifact names it regardless.
  assert.equal(waived.waiver?.id, "wv_1");
});

test("a real failure is waived, and stays distinguishable from a pass", () => {
  const waived = applyGateWaiver(
    failed,
    activeWaiverForRun(run(waiverRow()), NOW),
    NOW
  );
  assert.equal(waived.outcome, "waived");
  assert.notEqual(waived.outcome, "passed");
  assert.equal(evalGateExitCode(waived), 0);
});

// ── The CLI re-decides the waiver's validity ────────────────────────────────

test("an EXPIRED waiver is ignored even when the platform still calls it active", () => {
  // The operator residual this guards: a Convex query is cached against the
  // documents it read, and time is not a document — so a lapsed waiver can be
  // SERVED with `active: true` until something writes to its row. `eval gate`
  // computes its verdict independently by design, and re-deciding here is what
  // stops a time-boxed waiver from silently becoming a permanent one.
  const stale = waiverRow({ expiresAt: NOW - 1, active: true });
  assert.equal(activeWaiverForRun(run(stale), NOW), undefined);
  assert.equal(
    applyGateWaiver(failed, activeWaiverForRun(run(stale), NOW), NOW).outcome,
    "failed"
  );
});

test("a REVOKED waiver is ignored", () => {
  const revoked = waiverRow({ revokedAt: NOW - 1000, revokedBy: "usr_2" });
  assert.equal(activeWaiverForRun(run(revoked), NOW), undefined);
});

test("`active: false` is honored on its own", () => {
  assert.equal(
    activeWaiverForRun(run(waiverRow({ active: false })), NOW),
    undefined
  );
});

test("`null` and an ABSENT field both mean no waiver, and neither throws", () => {
  // Absent is an older deployment — "we do not know", not "not waived". Both
  // apply no waiver; what matters is that neither is noisy or fatal, because
  // every run gated against an older API would hit it.
  assert.equal(activeWaiverForRun(run(null), NOW), undefined);
  const legacy = run(null);
  delete (legacy as { gateWaiver?: unknown }).gateWaiver;
  assert.equal(activeWaiverForRun(legacy, NOW), undefined);
  assert.equal(activeWaiverForRun(undefined, NOW), undefined);
});

// ── The merge cannot be short-circuited by a waiver ─────────────────────────

test("a waived threshold half does not waive a baseline regression", () => {
  // `waived` ranks with `passed` in the merge precedence, so an unwaived
  // failure on the other half still decides the merged outcome. A waiver over
  // the threshold gate is not consent to ship a regression.
  const waived: GateReport = {
    outcome: "waived",
    scoreIntegrity: "valid",
    verdicts: [],
  };
  const regression: GateReport = {
    outcome: "failed",
    scoreIntegrity: "valid",
    verdicts: [
      { gate: "passRateRegression", status: "failed", message: "regressed" },
    ],
  };
  assert.equal(mergeGateReports(waived, regression).outcome, "failed");
});

// ── `--expires-in` ──────────────────────────────────────────────────────────

test("--expires-in parses minutes, hours and days into an instant", () => {
  assert.equal(parseWaiverExpiry("30m", NOW), NOW + 30 * 60_000);
  assert.equal(parseWaiverExpiry("12h", NOW), NOW + 12 * 3_600_000);
  assert.equal(parseWaiverExpiry("7d", NOW), NOW + 7 * DAY);
  assert.equal(parseWaiverExpiry(" 7d ", NOW), NOW + 7 * DAY);
  assert.equal(parseWaiverExpiry("7D", NOW), NOW + 7 * DAY);
});

test("--expires-in rejects a bare number as ambiguous", () => {
  // "7" is seven minutes or seven days depending on who is reading, and the
  // difference is a gate that reopens before lunch or three weeks later.
  assert.throws(() => parseWaiverExpiry("7", NOW), /must be a duration/);
  assert.throws(() => parseWaiverExpiry("", NOW), /must be a duration/);
  assert.throws(() => parseWaiverExpiry("soon", NOW), /must be a duration/);
  assert.throws(() => parseWaiverExpiry("7w", NOW), /must be a duration/);
  assert.throws(() => parseWaiverExpiry("-1d", NOW), /must be a duration/);
  assert.throws(() => parseWaiverExpiry("0d", NOW), /greater than zero/);
});

test("--expires-in does NOT enforce the 30-day cap locally", () => {
  // The platform's refusal carries copy naming the cap and what to do instead.
  // A local check firing first would replace that with a message invented
  // here, on exactly the boundary case where the specific one is useful.
  const far = parseWaiverExpiry("365d", NOW);
  assert.equal(far, NOW + 365 * DAY);
});

// ── The waiver a report carries is the one that was in force ───────────────

test("activeWaiverForRun projects who, why and until when", () => {
  const waiver = activeWaiverForRun(run(waiverRow()), NOW) as GateWaiver;
  assert.equal(waiver.createdByEmail, "alice@example.com");
  assert.equal(waiver.reason, "hotfix ships today; tracked in ENG-1");
  assert.equal(waiver.expiresAt, NOW + DAY);
  assert.deepEqual(waiver.policySnapshot, { minimumPassRate: 100 });
});
