import { describe, expect, it } from "vitest";
import type { PlatformEvalRunSummary } from "@mcpjam/sdk/platform";
import { getEvalOutcome } from "../src/ui/views/atoms.js";
import { summaryResult } from "../src/ui/views/evals.js";

/**
 * The eval widget's status dot backs `list_eval_suites`,
 * `list_eval_suite_runs` and `get_eval_run`, so what it claims is what an
 * agent reports back about a customer's server.
 *
 * These are asserted as NEGATIVES on the green dot and on the two verdict
 * words. The bug they pin was a fall-through — `inconclusive` matched neither
 * the `passed` nor the `failed` guard and landed in the `completed` arm — and
 * only a negative catches the next value that falls through the same way.
 */
describe("getEvalOutcome", () => {
  const EMERALD = "bg-emerald-500";

  it("never shows an inconclusive run as completed, passed, or green", () => {
    const outcome = getEvalOutcome("completed", "inconclusive");

    expect(outcome.dotClass).not.toBe(EMERALD);
    expect(outcome.label).not.toMatch(/passed|completed/i);
    expect(outcome.label).toBe("Inconclusive");
  });

  it("does not paint a verdict-less completed run green", () => {
    // Reaching the `completed` arm means no verdict was read. "Finished" is
    // not "passed", and emerald is the one colour that says it is.
    expect(getEvalOutcome("completed", null).dotClass).not.toBe(EMERALD);
    expect(getEvalOutcome("completed", undefined).dotClass).not.toBe(EMERALD);
  });

  it("still reads the two decided verdicts off `result`", () => {
    expect(getEvalOutcome("completed", "passed")).toMatchObject({
      label: "Passed",
      dotClass: EMERALD,
    });
    expect(getEvalOutcome("completed", "failed")).toMatchObject({
      label: "Failed",
      dotClass: "bg-red-500",
    });
  });

  it("reads a run held for its judge as non-terminal, not as a verdict", () => {
    // `grading` reaches the humanizing default arm rather than a case of its
    // own, and that arm is already right: amber and pulsing, because the run
    // is still happening. Pinned so a later explicit case cannot quietly
    // downgrade it to a terminal-looking badge.
    const outcome = getEvalOutcome("grading", "pending");

    expect(outcome.label).toBe("Grading");
    expect(outcome.dotClass).toBe("bg-amber-500");
    expect(outcome.pulse).toBe(true);
  });
});

describe("summaryResult — the suite card's latest-run verdict", () => {
  function summary(
    over: Partial<PlatformEvalRunSummary> = {}
  ): PlatformEvalRunSummary {
    return {
      id: "run-1",
      status: "completed",
      passRate: 0.25,
      passed: 1,
      failed: 3,
      createdAt: 1,
      ...over,
    };
  }

  it("reports an inconclusive run as inconclusive, never as failed", () => {
    // The defect: with failing trials present, the count fallback below
    // returned "failed" for a run the platform refused to decide.
    expect(summaryResult(summary({ result: "inconclusive" }))).toBe(
      "inconclusive"
    );
  });

  it("does not overrule a stored verdict with the counts", () => {
    // A run can pass with failing trials underneath it — a per-case threshold
    // below 100%. The counts say "failed"; the platform said "passed".
    expect(summaryResult(summary({ result: "passed" }))).toBe("passed");
  });

  it("shows the widget an inconclusive run as amber, end to end", () => {
    const run = summary({ result: "inconclusive" });
    const outcome = getEvalOutcome(run.status, summaryResult(run));

    expect(outcome.label).toBe("Inconclusive");
    expect(outcome.dotClass).not.toBe("bg-emerald-500");
    expect(outcome.dotClass).not.toBe("bg-red-500");
  });

  it("still derives from counts for a summary that carries no verdict", () => {
    expect(summaryResult(summary())).toBe("failed");
    expect(summaryResult(summary({ passed: 4, failed: 0 }))).toBe("passed");
    expect(summaryResult(summary({ status: "running" }))).toBeNull();
  });
});
