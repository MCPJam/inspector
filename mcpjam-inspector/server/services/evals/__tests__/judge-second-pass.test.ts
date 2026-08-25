import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  JudgeStageBackendError,
  type JudgeSecondPassRunRow,
  type JudgeStageDerivationBody,
} from "../judge-stage-backend.js";
import {
  judgeEvidenceFromVerdict,
  runJudgeSecondPass,
  type JudgeSecondPassPorts,
} from "../judge-second-pass.js";
import type { Predicate } from "@mcpjam/sdk/predicates";
import { hostedCriterionId } from "../score-definitions.js";

// =============================================================================
// The second pass is the only component that WRITES because of a judge, so the
// cases below are mostly about what it refuses to write: nothing at `off`,
// nothing at `shadow`, nothing for an iteration with no verdict, nothing for a
// terminal iteration, and never a lifecycle field.
// =============================================================================

const ENV_KEY = "MCPJAM_GRADING_ENGINE_MODE";
const originalEnv = process.env[ENV_KEY];

/**
 * The RAW authored case, as the backend's derivation-input route hands it back
 * (B3b). The pass derives the analyzer's `StageAuthoredCase` from it through
 * the SDK's `buildStageAuthoredCase` — the same function the runner used on the
 * first pass — rather than being handed a pre-derived one, so stage
 * applicability has exactly one implementation.
 *
 * This shape is `expectsToolCall: true, assertionCount: 1, model_driven`.
 */
const authoredCase = {
  expectedToolCalls: ["list_files"],
  expectedOutput: "done",
};

function runRow(
  over: Partial<JudgeSecondPassRunRow> = {}
): JudgeSecondPassRunRow {
  return {
    runId: "run1",
    goalCompletionJobId: "job1",
    configSnapshot: { gradingEngine: { mode: "dual_write" } },
    iterations: [
      {
        iterationId: "iter1",
        status: "completed",
        authoredCase,
        messages: [{ role: "user", content: "hi" }],
        metadata: {
          judgeVerdict: {
            status: "scored",
            verdict: "fail",
            score: 0.2,
            threshold: 0.8,
            partialFloor: 0.4,
            judgeTemplateVersion: 2,
            judgeTemplateHash: "tpl",
            model: "gpt-x",
          },
        },
      },
    ],
    ...over,
  };
}

type Applied = { iterationId: string; body: JudgeStageDerivationBody };

function ports(over: Partial<JudgeSecondPassPorts> = {}) {
  const applied: Applied[] = [];
  const reports: unknown[] = [];
  const value: JudgeSecondPassPorts = {
    fetchRun: vi.fn(async () => runRow()),
    applyDerivation: vi.fn(async (iterationId: string, body) => {
      applied.push({ iterationId, body });
      return { outcome: "applied" as const };
    }),
    markFanout: vi.fn(async (report) => {
      reports.push(report);
      return { outcome: "completed" };
    }),
    ...over,
  };
  return { value, applied, reports };
}

beforeEach(() => {
  process.env[ENV_KEY] = "dual_write";
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = originalEnv;
  vi.restoreAllMocks();
});

describe("the mode is checked before anything is read or written", () => {
  test("env off: not even the run is read", async () => {
    process.env[ENV_KEY] = "off";
    const { value } = ports();
    const result = await runJudgeSecondPass("run1", value);
    expect(result).toMatchObject({ noop: true, reason: "mode_off", graded: 0 });
    expect(value.fetchRun).not.toHaveBeenCalled();
    expect(value.applyDerivation).not.toHaveBeenCalled();
    expect(value.markFanout).not.toHaveBeenCalled();
  });

  test("an absent env var behaves as off", async () => {
    delete process.env[ENV_KEY];
    const { value } = ports();
    expect(await runJudgeSecondPass("run1", value)).toMatchObject({
      noop: true,
      reason: "mode_off",
    });
    expect(value.fetchRun).not.toHaveBeenCalled();
  });

  test("the run's snapshot says shadow: read, then write nothing", async () => {
    const { value } = ports({
      fetchRun: vi.fn(async () =>
        runRow({ configSnapshot: { gradingEngine: { mode: "shadow" } } })
      ),
    });
    const result = await runJudgeSecondPass("run1", value);
    expect(result).toMatchObject({ noop: true, reason: "mode_shadow" });
    expect(value.applyDerivation).not.toHaveBeenCalled();
    expect(value.markFanout).not.toHaveBeenCalled();
  });

  test("the run's snapshot wins over env: env dual_write, suite off", async () => {
    const { value } = ports({
      fetchRun: vi.fn(async () =>
        runRow({ configSnapshot: { gradingEngine: { mode: "off" } } })
      ),
    });
    expect(await runJudgeSecondPass("run1", value)).toMatchObject({
      noop: true,
      reason: "mode_off",
    });
    expect(value.applyDerivation).not.toHaveBeenCalled();
  });
});

describe("what it declines to grade", () => {
  test("an iteration with no judgeVerdict is not written and not reported", async () => {
    const { value } = ports({
      fetchRun: vi.fn(async () =>
        runRow({
          iterations: [
            {
              iterationId: "iter1",
              status: "completed",
              authoredCase,
              metadata: {},
            },
          ],
        })
      ),
    });
    const result = await runJudgeSecondPass("run1", value);
    expect(result).toMatchObject({ noop: true, reason: "no_judge_verdicts" });
    expect(value.applyDerivation).not.toHaveBeenCalled();
    expect(value.markFanout).not.toHaveBeenCalled();
  });

  test("a cancelled iteration is skipped even with a verdict", async () => {
    const base = runRow();
    const { value } = ports({
      fetchRun: vi.fn(async () =>
        runRow({
          iterations: [{ ...base.iterations[0]!, status: "cancelled" }],
        })
      ),
    });
    expect(await runJudgeSecondPass("run1", value)).toMatchObject({
      noop: true,
      reason: "no_judge_verdicts",
    });
    expect(value.applyDerivation).not.toHaveBeenCalled();
  });

  test("a run with no goalCompletionJobId writes nothing (the backend could not date it)", async () => {
    const { value } = ports({
      fetchRun: vi.fn(async () => {
        const row = runRow();
        delete row.goalCompletionJobId;
        return row;
      }),
    });
    expect(await runJudgeSecondPass("run1", value)).toMatchObject({
      noop: true,
      reason: "no_job_id",
    });
    expect(value.applyDerivation).not.toHaveBeenCalled();
  });

  test("an undeployed read route degrades to a no-op, not a throw", async () => {
    const { value } = ports({
      fetchRun: vi.fn(async () => {
        throw new JudgeStageBackendError("nope", 404, "ROUTE_NOT_DEPLOYED");
      }),
    });
    expect(await runJudgeSecondPass("run1", value)).toMatchObject({
      noop: true,
      reason: "backend_unavailable",
    });
    expect(value.applyDerivation).not.toHaveBeenCalled();
  });
});

describe("the write it does make", () => {
  test("posts only allowlisted derivation keys, never status or result", async () => {
    const { value, applied } = ports();
    const result = await runJudgeSecondPass("run1", value);
    expect(result).toMatchObject({ graded: 1, noop: false });
    expect(applied).toHaveLength(1);
    const body = applied[0]!.body as Record<string, unknown>;
    expect(body).not.toHaveProperty("status");
    expect(body).not.toHaveProperty("result");
    expect(body).not.toHaveProperty("passed");
    expect(body).not.toHaveProperty("metadata");
    const allowed = new Set([
      "goalCompletionJobId",
      "judgeStageDerivedAt",
      "stageResults",
      "firstFailedStage",
      "failureCategory",
      "stageAnalyzerVersion",
      "setupSignals",
      "toolSignals",
      "scores",
      "evaluationConfig",
    ]);
    for (const key of Object.keys(body)) expect(allowed.has(key)).toBe(true);
    expect(body.goalCompletionJobId).toBe("job1");
    expect(typeof body.judgeStageDerivedAt).toBe("number");
  });

  test("the judge verdict reaches userValue as a tier-2 row", async () => {
    const { value, applied } = ports();
    await runJudgeSecondPass("run1", value);
    const rows = applied[0]!.body.stageResults as Array<{
      stage: string;
      state: string;
      reason: string;
    }>;
    const userValue = rows.find((row) => row.stage === "userValue");
    expect(userValue).toMatchObject({ state: "failed", reason: "judgeFailed" });
    expect(applied[0]!.body.stageAnalyzerVersion).toBe(3);
  });

  test("reports exactly the iterations it graded", async () => {
    const base = runRow();
    const { value, reports } = ports({
      fetchRun: vi.fn(async () =>
        runRow({
          iterations: [
            base.iterations[0]!,
            // No verdict: graded by nobody, so reported by nobody.
            { iterationId: "iter2", status: "completed", metadata: {} },
          ],
        })
      ),
    });
    await runJudgeSecondPass("run1", value);
    expect(reports).toEqual([
      {
        runId: "run1",
        goalCompletionJobId: "job1",
        outcomes: [{ iterationId: "iter1", outcome: "applied" }],
      },
    ]);
  });

  test("a stale job is reported as stale rather than retried", async () => {
    const { value, reports } = ports({
      applyDerivation: vi.fn(async () => ({ outcome: "stale" as const })),
    });
    const result = await runJudgeSecondPass("run1", value);
    expect(result.outcomes).toEqual([
      { iterationId: "iter1", outcome: "stale" },
    ]);
    expect(reports).toHaveLength(1);
  });

  test("a terminal iteration comes back skipped_terminal and is still reported", async () => {
    const { value } = ports({
      applyDerivation: vi.fn(async () => ({
        outcome: "skipped_terminal" as const,
      })),
    });
    expect((await runJudgeSecondPass("run1", value)).outcomes).toEqual([
      { iterationId: "iter1", outcome: "skipped_terminal" },
    ]);
  });

  test("a vanished iteration is skipped without a report entry", async () => {
    const { value, reports } = ports({
      applyDerivation: vi.fn(async () => {
        throw new JudgeStageBackendError("gone", 404);
      }),
    });
    expect(await runJudgeSecondPass("run1", value)).toMatchObject({
      noop: true,
      reason: "no_judge_verdicts",
    });
    expect(reports).toHaveLength(0);
  });

  test("a config conflict stops the pass and reports failure", async () => {
    const { value, reports } = ports({
      applyDerivation: vi.fn(async () => {
        throw new JudgeStageBackendError(
          "conflict",
          409,
          "EVAL_RUN_CONFIG_CONFLICT"
        );
      }),
    });
    await runJudgeSecondPass("run1", value);
    expect(reports).toEqual([
      {
        runId: "run1",
        goalCompletionJobId: "job1",
        outcomes: [],
        failed: true,
      },
    ]);
  });

  test("re-running produces the same write and the same report", async () => {
    const first = ports();
    const second = ports();
    await runJudgeSecondPass("run1", first.value);
    await runJudgeSecondPass("run1", second.value);
    const strip = (body: JudgeStageDerivationBody) => ({
      ...body,
      judgeStageDerivedAt: 0,
    });
    expect(strip(second.applied[0]!.body)).toEqual(
      strip(first.applied[0]!.body)
    );
    expect(second.reports).toEqual(first.reports);
  });

  test("a failing fanout report does not fail the pass (the sweep retries)", async () => {
    const { value } = ports({
      markFanout: vi.fn(async () => {
        throw new JudgeStageBackendError("nope", 404, "ROUTE_NOT_DEPLOYED");
      }),
    });
    expect(await runJudgeSecondPass("run1", value)).toMatchObject({
      graded: 1,
      noop: false,
    });
  });
});

describe("judgeEvidenceFromVerdict", () => {
  test("a band becomes scored evidence", () => {
    for (const verdict of ["pass", "partial", "fail"] as const) {
      expect(judgeEvidenceFromVerdict({ status: "scored", verdict })).toEqual({
        status: "scored",
        verdict,
      });
    }
  });

  test("a broken grader is an error, not a failure", () => {
    expect(judgeEvidenceFromVerdict({ status: "error" })).toEqual({
      status: "error",
    });
  });

  test("a skipped judge falls through to the deterministic evidence", () => {
    expect(judgeEvidenceFromVerdict({ status: "skipped" })).toEqual({
      status: "skipped",
    });
  });

  test("a verdict row with no band is pending, never a silent pass", () => {
    expect(judgeEvidenceFromVerdict({ status: "scored" })).toEqual({
      status: "pending",
      pendingKind: "scheduled",
    });
  });

  test("no verdict at all yields no evidence", () => {
    expect(judgeEvidenceFromVerdict(undefined)).toBeUndefined();
  });
});

// =============================================================================
// B3b review follow-ups. Two independent derivations, two ways to get them
// wrong — both of which only became reachable once `dual_write` had a cohort.
// =============================================================================
describe("the second pass preserves scorer identity and never loses a score row", () => {
  test("a turn-scoped predicate rebuilds under the SAME scorer identity", async () => {
    const scopedPredicate = {
      type: "tool_called",
      toolName: "list_files",
    } as unknown as Predicate;
    const scope = { kind: "turn" as const, promptIndex: 1 };

    const { value, applied } = ports({
      fetchRun: vi.fn(async () =>
        runRow({
          iterations: [
            {
              iterationId: "iter1",
              status: "completed",
              authoredCase,
              metadata: {
                judgeVerdict: {
                  status: "scored",
                  verdict: "fail",
                  score: 0.2,
                  threshold: 0.8,
                },
                predicates: [
                  { predicate: scopedPredicate, passed: true, scope },
                ],
              },
            },
          ],
        })
      ),
    });
    await runJudgeSecondPass("run1", value);

    const scores = (applied[0]?.body.scores ?? []) as Array<{
      scorerId: string;
    }>;
    const predicateRow = scores.find((row) =>
      row.scorerId.startsWith("predicate:")
    );
    // The identity the FIRST pass would have written for the same scoped
    // predicate. `hostedCriterionId` digests the scope, so dropping it here
    // does not correct the original row — it mints a second, unscoped gating
    // scorer beside it, or conflicts outright.
    expect(predicateRow?.scorerId).toBe(
      `predicate:${hostedCriterionId(scopedPredicate, scope)}`
    );
  });

  test("an incomplete trace suppresses the CHAIN but still posts the score rows", async () => {
    const { value, applied } = ports({
      fetchRun: vi.fn(async () =>
        runRow({
          iterations: [
            {
              iterationId: "iter1",
              status: "completed",
              authoredCase,
              // The backend could not serve this iteration's spans.
              traceComplete: false,
              metadata: {
                judgeVerdict: {
                  status: "scored",
                  verdict: "fail",
                  score: 0.2,
                  threshold: 0.8,
                },
                predicates: [
                  {
                    predicate: {
                      type: "tool_called",
                      toolName: "list_files",
                    } as unknown as Predicate,
                    passed: true,
                  },
                ],
              },
            },
          ],
        })
      ),
    });
    const result = await runJudgeSecondPass("run1", value);

    const body = applied[0]?.body;
    // No chain: re-deriving it without spans would report `traceAbsent` and
    // overwrite a correct first-pass chain with one saying nothing happened.
    expect(body?.stageResults).toBeUndefined();
    // …and no version stamp either, which would claim a derivation that did
    // not happen and misdate the chain already on the row.
    expect(body?.stageAnalyzerVersion).toBeUndefined();
    // But the judge's row IS projected — it needs no trace — and the iteration
    // is reported, so the fanout can complete instead of being re-driven until
    // it gives up.
    expect((body?.scores ?? []).length).toBeGreaterThan(0);
    expect(result.outcomes).toHaveLength(1);
  });

  test("an iteration with neither a chain nor scores is still skipped", async () => {
    // `shadow` produces no score rows, so an incomplete trace leaves nothing
    // at all to post. Reporting it anyway would mark a fanout complete for an
    // iteration this pass never graded.
    const { value, applied } = ports({
      fetchRun: vi.fn(async () =>
        runRow({
          configSnapshot: { gradingEngine: { mode: "shadow" } },
          iterations: [
            {
              iterationId: "iter1",
              status: "completed",
              authoredCase,
              traceComplete: false,
              metadata: {
                judgeVerdict: { status: "scored", verdict: "fail" },
              },
            },
          ],
        })
      ),
    });
    const result = await runJudgeSecondPass("run1", value);

    expect(applied).toHaveLength(0);
    expect(result.noop).toBe(true);
  });
});

// =============================================================================
// The fetch port FOLLOWS THE CURSOR, and a partial fetch never completes a
// fanout.
//
// The backend pages at 200 iterations. A consumer that took only the first page
// would grade the head of a long run, report every outcome as applied, and let
// `markFanout` close the fanout — leaving the tail permanently ungraded with
// nothing to re-drive it.
// =============================================================================
describe("a partially fetched run is never reported complete", () => {
  test("an incomplete fetch reports failed so the sweep re-drives it", async () => {
    const reported: Array<{ failed?: boolean }> = [];
    const { value } = ports({
      fetchRun: vi.fn(async () => ({
        ...runRow(),
        // More iterations exist than this fetch retrieved.
        incomplete: true,
      })),
      markFanout: vi.fn(async (report) => {
        reported.push(report);
        return { outcome: "pending" };
      }),
    });

    await runJudgeSecondPass("run1", value);

    // Without this the backend sees an all-success report and marks the run's
    // fanout COMPLETE — it cannot tell a fully graded run from a partially
    // fetched one.
    expect(reported[0]?.failed).toBe(true);
  });

  test("a complete fetch reports no failure", async () => {
    const reported: Array<{ failed?: boolean }> = [];
    const { value } = ports({
      markFanout: vi.fn(async (report) => {
        reported.push(report);
        return { outcome: "completed" };
      }),
    });

    await runJudgeSecondPass("run1", value);

    expect(reported[0]?.failed).toBeUndefined();
  });
});

// =============================================================================
// THE TOOL-MATCH DEFINITION MUST SURVIVE THE SECOND PASS.
//
// The backend merges `scores` by `scorerId` but REPLACES `evaluationConfig`
// wholesale. So a second-pass config missing `toolCalls:match` does not merely
// omit a scorer — it leaves the FIRST pass's tool-match row in place with its
// definition deleted:
//
//   - the row becomes unjoinable, so score-integrity marks the run invalid;
//   - the per-case `evaluationConfigHash` no longer matches, raising
//     `EVAL_RUN_CONFIG_CONFLICT`;
//   - and at `enforce`, `allGatingScorersPassed` iterates DEFINITIONS, so a
//     gating scorer simply vanishes from the verdict — a failing tool match
//     stops failing the iteration.
//
// Forwarding `matchOptions` was necessary and not sufficient: the definition is
// built only when the case authored expectations, and that was read off
// `evaluation`, which this pass structurally cannot supply.
// =============================================================================
describe("the second pass redeclares the scorers the first pass wrote", () => {
  function postedConfig(applied: Applied[]) {
    return applied[0]?.body?.evaluationConfig as
      | { definitions?: Array<{ scorerId?: string }> }
      | undefined;
  }

  test("a case with authored tool calls keeps its toolCalls:match definition", async () => {
    const { value, applied } = ports();
    await runJudgeSecondPass("run1", value);

    const ids = (postedConfig(applied)?.definitions ?? []).map(
      (definition) => definition.scorerId
    );
    expect(ids).toContain("toolCalls:match");
  });

  test("but posts NO tool-match row — it never ran the matcher", async () => {
    // The definition and the row have different preconditions. Fabricating a
    // row here would author a verdict for a scorer this pass has no evidence
    // for; the backend's merge keeps the first pass's real row instead.
    const { value, applied } = ports();
    await runJudgeSecondPass("run1", value);

    const scores = (applied[0]?.body?.scores ?? []) as Array<{
      scorerId?: string;
    }>;
    expect(scores.some((row) => row.scorerId === "toolCalls:match")).toBe(false);
    // The judge's own row is still there — this pass's actual output.
    expect(scores.some((row) => row.scorerId === "judge:goalCompletion")).toBe(
      true
    );
  });

  test("a case that authored NO tool calls declares no such scorer", async () => {
    // Absence must stay absence: a vacuously passing tool-match gate would be
    // invented evidence, and at `enforce` it would be a gating one.
    const { value, applied } = ports({
      fetchRun: vi.fn(async () => {
        const row = runRow();
        return {
          ...row,
          iterations: row.iterations.map((iteration) => ({
            ...iteration,
            authoredCase: { expectedOutput: "done" },
          })),
        };
      }),
    });
    await runJudgeSecondPass("run1", value);

    const ids = (postedConfig(applied)?.definitions ?? []).map(
      (definition) => definition.scorerId
    );
    expect(ids).not.toContain("toolCalls:match");
  });
});
