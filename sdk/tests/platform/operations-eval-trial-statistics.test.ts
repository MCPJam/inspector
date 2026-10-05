/**
 * `get_eval_run` carries the run's report-only trial statistics even when the
 * API deployment that answered predates the field.
 *
 * Same posture as the decision-summary fallback: a model reading a run over
 * MCP and a human reading it through `eval status --json` must not see
 * different evidence merely because the additive field has not rolled out.
 * The statistics are computed only from a decision that parses against the
 * contract — the function the API itself uses — and never from `summary`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withEvalRunTrialStatistics } from "../../src/platform/operations.js";
import { evalVerdictTrialStatistics } from "../../src/contract/verdict-aggregate.js";
import type { EvalVerdictDecision } from "../../src/contract/verdict-policy.js";
import type { PlatformEvalRun } from "../../src/platform/types.js";

const corpus = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        "../fixtures/eval-verdict-run-aggregation-parity-fixtures.json",
        import.meta.url
      )
    ),
    "utf8"
  )
) as {
  runs: Array<{
    expected: EvalVerdictDecision;
    expectedTrialStatistics: unknown;
  }>;
};

const ROW = corpus.runs[0]!;

function run(overrides: Partial<PlatformEvalRun> = {}): PlatformEvalRun {
  return {
    id: "run-1",
    suiteId: "suite-1",
    runNumber: 1,
    status: "completed",
    result: ROW.expected.verdict,
    summary: null,
    source: "api",
    notes: null,
    createdAt: 1,
    completedAt: 2,
    ...overrides,
  } as PlatformEvalRun;
}

describe("withEvalRunTrialStatistics", () => {
  it("fills the field from a valid v2 decision, matching the backend bytes", () => {
    const filled = withEvalRunTrialStatistics(
      run({ verdictPolicyVersion: 2, verdictSummary: ROW.expected })
    );
    expect(filled.trialStatistics).toEqual(ROW.expectedTrialStatistics);
  });

  it("returns a response that already carries the field untouched", () => {
    const answered = run({
      verdictPolicyVersion: 2,
      verdictSummary: ROW.expected,
      trialStatistics: evalVerdictTrialStatistics(ROW.expected),
    });
    expect(withEvalRunTrialStatistics(answered)).toBe(answered);
  });

  it("adds nothing to a legacy run or an unreadable decision", () => {
    const legacy = run({
      summary: { total: 3, passed: 2, failed: 1, passRate: 2 / 3 },
    });
    expect(withEvalRunTrialStatistics(legacy)).not.toHaveProperty(
      "trialStatistics"
    );
    const unreadable = run({
      verdictPolicyVersion: 2,
      verdictSummary: { ...ROW.expected, verdict: "bogus" } as never,
    });
    expect(withEvalRunTrialStatistics(unreadable)).not.toHaveProperty(
      "trialStatistics"
    );
  });
});
