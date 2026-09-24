import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { StageAuthoredCase } from "@mcpjam/sdk/contract";
import {
  LATENCY_BASIS_EVIDENCE_SPAN_UNION,
  STAGE_ANALYZER_VERSION,
  STAGE_MEASUREMENTS_SCHEMA_VERSION,
} from "@mcpjam/sdk/contract";
import {
  JudgeStageBackendError,
  type JudgeSecondPassRunRow,
  type JudgeStageDerivationBody,
  type MetadataAttributionStageDerivationBody,
} from "../judge-stage-backend.js";
import {
  deriveIterationPayload,
  judgeEvidenceFromVerdict,
  stepErrorFromStoredChain,
  metadataAttributionEvidenceFromVerdict,
  runJudgeSecondPass,
  type JudgeSecondPassPorts,
} from "../judge-second-pass.js";
import type { Predicate } from "@mcpjam/sdk/predicates";
import {
  HOSTED_TOOL_ARGUMENTS_SCORER_ID,
  HOSTED_TOOL_MATCH_SCORER_ID,
  hostedCriterionId,
} from "../score-definitions.js";
import {
  authoredRequiredRole,
  buildEvaluationConfigSnapshot,
  canonicalDigest,
  definitionHash,
  fromCriterionResult,
  type ResolvedScoreDefinition,
} from "@mcpjam/sdk/contract";
import { buildHostedScoreContract } from "../score-rows.js";
import { buildIterationFinishParams } from "../finalize-iteration.js";
import { evaluateMultiTurnResults } from "../types.js";
import {
  normalizeSteps,
  resolvePromptTurns,
  stepsToPromptTurns,
} from "@/shared/steps";

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

/**
 * The DERIVED shape, as the backend also serves it (`stageCase`) for D7's
 * consumer.
 *
 * Both fields ride the same wire row and both paths are exercised: a row with
 * `authoredCase` is derived here through the SDK, and a row with only
 * `stageCase` falls back to the backend's. Keeping a fixture for each is what
 * stops the fallback rotting silently once every hosted row carries the raw
 * case.
 */
const stageCase: StageAuthoredCase = {
  mode: "model_driven",
  expectsToolCall: true,
  assertionCount: 1,
};

function runRow(
  over: Partial<JudgeSecondPassRunRow> = {},
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
type AppliedMetadataAttribution = {
  iterationId: string;
  body: MetadataAttributionStageDerivationBody;
};

function ports(over: Partial<JudgeSecondPassPorts> = {}) {
  const applied: Applied[] = [];
  const reports: unknown[] = [];
  const appliedMetadataAttribution: AppliedMetadataAttribution[] = [];
  const metadataAttributionReports: unknown[] = [];
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
    applyMetadataAttributionDerivation: vi.fn(
      async (iterationId: string, body) => {
        appliedMetadataAttribution.push({ iterationId, body });
        return { outcome: "applied" as const };
      },
    ),
    markMetadataAttributionFanout: vi.fn(async (report) => {
      metadataAttributionReports.push(report);
      return { outcome: "completed" };
    }),
    ...over,
  };
  return {
    value,
    applied,
    reports,
    appliedMetadataAttribution,
    metadataAttributionReports,
  };
}

beforeEach(() => {
  process.env[ENV_KEY] = "dual_write";
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = originalEnv;
  vi.restoreAllMocks();
});

describe("no-op modes settle fanout without grading", () => {
  test("env off: reads job ids and settles without deriving", async () => {
    process.env[ENV_KEY] = "off";
    const { value } = ports();
    const result = await runJudgeSecondPass("run1", value);
    expect(result).toMatchObject({ noop: true, reason: "mode_off", graded: 0 });
    expect(value.fetchRun).toHaveBeenCalledWith("run1");
    expect(value.applyDerivation).not.toHaveBeenCalled();
    expect(value.markFanout).toHaveBeenCalledWith({
      runId: "run1",
      goalCompletionJobId: "job1",
      outcomes: [],
      noop: true,
    });
  });

  test("an absent env var behaves as off", async () => {
    delete process.env[ENV_KEY];
    const { value } = ports();
    expect(await runJudgeSecondPass("run1", value)).toMatchObject({
      noop: true,
      reason: "mode_off",
    });
    expect(value.fetchRun).toHaveBeenCalledWith("run1");
  });

  test("the run's snapshot says shadow: settle without derivation", async () => {
    const { value } = ports({
      fetchRun: vi.fn(async () =>
        runRow({ configSnapshot: { gradingEngine: { mode: "shadow" } } }),
      ),
    });
    const result = await runJudgeSecondPass("run1", value);
    expect(result).toMatchObject({ noop: true, reason: "mode_shadow" });
    expect(value.applyDerivation).not.toHaveBeenCalled();
    expect(value.markFanout).toHaveBeenCalledWith({
      runId: "run1",
      goalCompletionJobId: "job1",
      outcomes: [],
      noop: true,
    });
  });

  test("the run's snapshot wins over env: env dual_write, suite off", async () => {
    const { value } = ports({
      fetchRun: vi.fn(async () =>
        runRow({ configSnapshot: { gradingEngine: { mode: "off" } } }),
      ),
    });
    expect(await runJudgeSecondPass("run1", value)).toMatchObject({
      noop: true,
      reason: "mode_off",
    });
    expect(value.applyDerivation).not.toHaveBeenCalled();
  });
});

describe("no-op fanout completion", () => {
  test.each(["off", "shadow", "dual_write"] as const)(
    "%s settles both empty fanouts",
    async (mode) => {
      const { value } = ports({
        fetchRun: vi.fn(async () =>
          runRow({
            configSnapshot: { gradingEngine: { mode } },
            metadataAttributionJobId: "metadata1",
            iterations: [],
          }),
        ),
      });
      await runJudgeSecondPass("run1", value);
      expect(value.applyDerivation).not.toHaveBeenCalled();
      expect(value.applyMetadataAttributionDerivation).not.toHaveBeenCalled();
      expect(value.markFanout).toHaveBeenCalledWith({
        runId: "run1",
        goalCompletionJobId: "job1",
        outcomes: [],
        noop: true,
      });
      expect(value.markMetadataAttributionFanout).toHaveBeenCalledWith({
        runId: "run1",
        metadataAttributionJobId: "metadata1",
        outcomes: [],
        noop: true,
      });
    },
  );

  test("an incomplete empty read cannot claim successful completion", async () => {
    const { value } = ports({
      fetchRun: vi.fn(async () => runRow({ iterations: [], incomplete: true })),
    });
    await runJudgeSecondPass("run1", value);
    expect(value.markFanout).toHaveBeenCalledWith({
      runId: "run1",
      goalCompletionJobId: "job1",
      outcomes: [],
      noop: true,
      failed: true,
    });
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
        }),
      ),
    });
    const result = await runJudgeSecondPass("run1", value);
    expect(result).toMatchObject({ noop: true, reason: "no_judge_verdicts" });
    expect(value.applyDerivation).not.toHaveBeenCalled();
    expect(value.markFanout).toHaveBeenCalledWith({
      runId: "run1",
      goalCompletionJobId: "job1",
      outcomes: [],
      noop: true,
    });
  });

  test("a cancelled iteration is skipped even with a verdict", async () => {
    const base = runRow();
    const { value } = ports({
      fetchRun: vi.fn(async () =>
        runRow({
          iterations: [{ ...base.iterations[0]!, status: "cancelled" }],
        }),
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
      "stageMeasurements",
      "setupSignals",
      "toolSignals",
      "scores",
      "evaluationConfig",
    ]);
    for (const key of Object.keys(body)) expect(allowed.has(key)).toBe(true);
    expect(body.goalCompletionJobId).toBe("job1");
    expect(typeof body.judgeStageDerivedAt).toBe("number");
  });

  test("forwards derived stage measurements from the persisted trace", async () => {
    const base = runRow();
    const { value, applied } = ports({
      fetchRun: vi.fn(async () =>
        runRow({
          iterations: [
            {
              ...base.iterations[0]!,
              spans: [
                {
                  id: "tool-1",
                  name: "tools/call",
                  category: "tool",
                  startMs: 100,
                  endMs: 175,
                },
              ],
            },
          ],
        }),
      ),
    });

    await runJudgeSecondPass("run1", value);

    expect(applied[0]!.body.stageMeasurements).toEqual({
      schemaVersion: STAGE_MEASUREMENTS_SCHEMA_VERSION,
      stageAnalyzerVersion: STAGE_ANALYZER_VERSION,
      rows: [
        { stage: "connection", reach: "reached" },
        { stage: "discovery", reach: "reached" },
        { stage: "selection", reach: "unknown" },
        {
          stage: "call",
          reach: "reached",
          latency: {
            unit: "ms",
            basis: LATENCY_BASIS_EVIDENCE_SPAN_UNION,
            value: 75,
          },
        },
        {
          stage: "response",
          reach: "reached",
          latency: {
            unit: "ms",
            basis: LATENCY_BASIS_EVIDENCE_SPAN_UNION,
            value: 75,
          },
        },
        { stage: "userValue", reach: "reached" },
      ],
    });
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
    expect(applied[0]!.body.stageAnalyzerVersion).toBe(STAGE_ANALYZER_VERSION);
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
        }),
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
    expect(reports).toEqual([
      { runId: "run1", goalCompletionJobId: "job1", outcomes: [], noop: true },
    ]);
  });

  test("a config conflict stops the pass and reports failure", async () => {
    const { value, reports } = ports({
      applyDerivation: vi.fn(async () => {
        throw new JudgeStageBackendError(
          "conflict",
          409,
          "EVAL_RUN_CONFIG_CONFLICT",
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
      strip(first.applied[0]!.body),
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

  // ── UVH-IN4: a judged row can say something for itself ────────────────────
  //
  // Before this, `reasons` was never populated on this path, so
  // `boundedJudgeReasons` returned undefined and every judgeObserved /
  // judgePartial / judgeFailed row reached a reader as a bare verdict.

  test("a scored row carries the numbers it was decided from", () => {
    expect(
      judgeEvidenceFromVerdict({
        status: "scored",
        verdict: "partial",
        score: 0.42,
        threshold: 0.7,
      }),
    ).toEqual({
      status: "scored",
      verdict: "partial",
      reasons: ["LLM judge scored 0.42 against a 0.7 threshold"],
    });
  });

  test("names the partial floor when the floor decided the band", () => {
    // Review finding: with only the threshold shown, 0.5 against 0.7 reads as
    // a plain miss and says nothing about why it failed rather than landing in
    // the partial band. The floor is one of the numbers the decision turned
    // on, so evidence that omits it cannot explain the claim it supports.
    expect(
      judgeEvidenceFromVerdict({
        status: "scored",
        verdict: "fail",
        score: 0.5,
        threshold: 0.7,
        partialFloor: 0.6,
      }),
    ).toEqual({
      status: "scored",
      verdict: "fail",
      reasons: [
        "LLM judge scored 0.5 against a 0.7 threshold and a 0.6 partial floor",
      ],
    });
  });

  test("leaves the floor out of a band it did not decide", () => {
    // A pass is settled by the threshold alone. Naming a floor there would put
    // a number in front of a reader that had no part in the outcome.
    expect(
      judgeEvidenceFromVerdict({
        status: "scored",
        verdict: "pass",
        score: 0.9,
        threshold: 0.7,
        partialFloor: 0.6,
      }),
    ).toEqual({
      status: "scored",
      verdict: "pass",
      reasons: ["LLM judge scored 0.9 against a 0.7 threshold"],
    });
  });

  test("never rounds a score onto the boundary it fell short of", () => {
    // Review finding: at two decimals, 0.699 against a 0.7 threshold rendered
    // as "scored 0.7 against a 0.7 threshold" — evidence flatly contradicting
    // the `fail` band beside it, with no way for a reader to tell which was
    // wrong. Precision grows only as far as it must to keep the comparison
    // true.
    const evidence = judgeEvidenceFromVerdict({
      status: "scored",
      verdict: "fail",
      score: 0.699,
      threshold: 0.7,
    });
    const [line] = (evidence as { reasons: string[] }).reasons;
    expect(line).toBe("LLM judge scored 0.699 against a 0.7 threshold");
    expect(line).not.toContain("scored 0.7 against");
  });

  test("keeps a narrow partial band from collapsing to one number", () => {
    // Review finding on the first version of the precision fix: it compared
    // each boundary only with the SCORE, so a 0.7001 threshold and a 0.6999
    // floor both rendered `0.7` while the score sat far from either. The line
    // whose whole job is to show the band's width erased it.
    const [line] = (
      judgeEvidenceFromVerdict({
        status: "scored",
        verdict: "fail",
        score: 0.5,
        threshold: 0.7001,
        partialFloor: 0.6999,
      }) as { reasons: string[] }
    ).reasons;
    expect(line).toContain("0.7001 threshold");
    expect(line).toContain("0.6999 partial floor");
  });

  test("admits the rounding rather than claiming two values are equal", () => {
    // The cap's own blind spot. Precision stops growing at six decimals — past
    // that a judge score is float noise — but it used to fall through to the
    // six-decimal rendering ANYWAY, printing two different numbers identically.
    // "scored 0.7 against a 0.7 threshold" for values that were never equal is
    // the exact contradiction the whole function exists to prevent.
    const [line] = (
      judgeEvidenceFromVerdict({
        status: "scored",
        verdict: "fail",
        score: 0.70000001,
        threshold: 0.70000002,
      }) as { reasons: string[] }
    ).reasons;

    // Both are marked, because each is indistinguishable from the other...
    expect(line).toBe(
      "LLM judge scored \u22480.7 against a \u22480.7 threshold",
    );
    // ...and crucially the line no longer ASSERTS they are the same number.
    expect(line).not.toBe("LLM judge scored 0.7 against a 0.7 threshold");
  });

  test("marks only the values that actually collide", () => {
    // A blanket marker would make a number the reader CAN trust look uncertain.
    // The floor here is distinguishable at six decimals; the other two are not.
    const [line] = (
      judgeEvidenceFromVerdict({
        status: "scored",
        verdict: "fail",
        score: 0.70000001,
        threshold: 0.70000002,
        partialFloor: 0.5,
      }) as { reasons: string[] }
    ).reasons;
    expect(line).toContain("0.5 partial floor");
    expect(line).not.toContain("\u22480.5");
  });

  test("still reads equal when the score IS the threshold", () => {
    // The other half: growing precision must not manufacture a difference
    // where none exists. A score exactly on its threshold should say so.
    expect(
      judgeEvidenceFromVerdict({
        status: "scored",
        verdict: "pass",
        score: 0.7,
        threshold: 0.7,
      }),
    ).toEqual({
      status: "scored",
      verdict: "pass",
      reasons: ["LLM judge scored 0.7 against a 0.7 threshold"],
    });
  });

  test("still trims float noise from a model-supplied score", () => {
    // The reason rounding existed at all. A judge can return
    // 0.42000000000000004, and showing that to a person displays precision the
    // verdict never had.
    expect(
      judgeEvidenceFromVerdict({
        status: "scored",
        verdict: "partial",
        score: 0.42000000000000004,
        threshold: 0.7,
      }),
    ).toEqual({
      status: "scored",
      verdict: "partial",
      reasons: ["LLM judge scored 0.42 against a 0.7 threshold"],
    });
  });

  test("the judge's own rationale wins over the numbers", () => {
    // Not written by the backend today — a scored case's `reason` is dropped
    // — but read here so the gap closes the moment it is persisted, without
    // a second change on this side.
    expect(
      judgeEvidenceFromVerdict({
        status: "scored",
        verdict: "fail",
        score: 0.1,
        threshold: 0.7,
        reason: "the answer never named the order id",
      }),
    ).toEqual({
      status: "scored",
      verdict: "fail",
      reasons: ["the answer never named the order id"],
    });
  });

  test("an error band carries WHY the judge could not score", () => {
    // The one rationale the backend does persist.
    expect(
      judgeEvidenceFromVerdict({ status: "error", error: "model timed out" }),
    ).toEqual({ status: "error", reasons: ["model timed out"] });
  });

  test("a scored row with no numbers stays bare rather than inventing one", () => {
    expect(
      judgeEvidenceFromVerdict({ status: "scored", verdict: "pass" }),
    ).toEqual({ status: "scored", verdict: "pass" });
  });
});

describe("metadataAttributionEvidenceFromVerdict", () => {
  test("a scored verdict carries attributed + reasons", () => {
    expect(
      metadataAttributionEvidenceFromVerdict({
        status: "scored",
        attributed: true,
        reasons: ["quoted description text"],
      }),
    ).toEqual({
      status: "scored",
      attributed: true,
      reasons: ["quoted description text"],
    });
  });

  test("attributed is never a silent default — an unattributed scored verdict says so explicitly", () => {
    expect(
      metadataAttributionEvidenceFromVerdict({
        status: "scored",
        attributed: false,
        reasons: [],
      }),
    ).toEqual({ status: "scored", attributed: false });
  });

  test("a broken judge is an error, not a failure", () => {
    expect(metadataAttributionEvidenceFromVerdict({ status: "error" })).toEqual(
      { status: "error" },
    );
  });

  test("a skipped judge falls through to the deterministic evidence", () => {
    expect(
      metadataAttributionEvidenceFromVerdict({ status: "skipped" }),
    ).toEqual({ status: "skipped" });
  });

  test("an unrecognized status is pending, never a silent unattributed default", () => {
    expect(metadataAttributionEvidenceFromVerdict({ status: "weird" })).toEqual(
      { status: "pending", pendingKind: "scheduled" },
    );
  });

  test("not_applicable is its own terminal outcome, never relabeled as pending", () => {
    expect(
      metadataAttributionEvidenceFromVerdict({ status: "not_applicable" }),
    ).toEqual({ status: "not_applicable" });
  });

  test("no verdict at all yields no evidence", () => {
    expect(metadataAttributionEvidenceFromVerdict(undefined)).toBeUndefined();
  });
});

describe("D7: metadata-attribution rides the same second pass", () => {
  const d7Row = (over: Partial<JudgeSecondPassRunRow> = {}) =>
    runRow({
      goalCompletionJobId: undefined,
      metadataAttributionJobId: "d7-job1",
      iterations: [
        {
          iterationId: "iter1",
          status: "completed",
          stageCase,
          prompts: [
            {
              promptIndex: 0,
              prompt: "what's the weather?",
              expectedToolCalls: [{ toolName: "get_weather", arguments: {} }],
              actualToolCalls: [],
              missing: [{ toolName: "get_weather", arguments: {} }],
              unexpected: [],
              argumentMismatches: [],
              passed: false,
            },
          ],
          metadata: {
            metadataAttributionVerdict: {
              status: "scored",
              attributed: true,
              reasons: ["the description says it searches files"],
            },
          },
        },
      ],
      ...over,
    });

  test("a D7-only run (no goalCompletionJobId) still writes and reports", async () => {
    const { value, appliedMetadataAttribution, metadataAttributionReports } =
      ports({ fetchRun: vi.fn(async () => d7Row()) });
    const result = await runJudgeSecondPass("run1", value);

    expect(result).toMatchObject({ noop: false, graded: 1 });
    expect(result.outcomes).toEqual([]);
    expect(result.metadataAttributionOutcomes).toEqual([
      { iterationId: "iter1", outcome: "applied" },
    ]);
    expect(value.applyDerivation).not.toHaveBeenCalled();
    expect(value.markFanout).not.toHaveBeenCalled();
    expect(appliedMetadataAttribution).toHaveLength(1);
    const body = appliedMetadataAttribution[0]!.body as Record<string, unknown>;
    expect(body).not.toHaveProperty("status");
    expect(body).not.toHaveProperty("result");
    expect(body).not.toHaveProperty("scores");
    expect(body).not.toHaveProperty("evaluationConfig");
    expect(body.metadataAttributionJobId).toBe("d7-job1");
    const rows = body.stageResults as Array<{
      stage: string;
      state: string;
      reason: string;
    }>;
    expect(rows.find((r) => r.stage === "selection")).toMatchObject({
      state: "failed",
      reason: "missingToolCall",
    });
    expect(body.failureCategory).toBe("metadata");
    expect(metadataAttributionReports).toEqual([
      {
        runId: "run1",
        metadataAttributionJobId: "d7-job1",
        outcomes: [{ iterationId: "iter1", outcome: "applied" }],
      },
    ]);
  });

  test("an unattributed selection failure still writes, but stays failureCategory: selection", async () => {
    const { value, appliedMetadataAttribution } = ports({
      fetchRun: vi.fn(async () =>
        d7Row({
          iterations: [
            {
              ...d7Row().iterations[0]!,
              metadata: {
                metadataAttributionVerdict: {
                  status: "scored",
                  attributed: false,
                  reasons: [],
                },
              },
            },
          ],
        }),
      ),
    });
    await runJudgeSecondPass("run1", value);
    const body = appliedMetadataAttribution[0]!.body as Record<string, unknown>;
    expect(body.failureCategory).toBe("selection");
  });

  test("both judges fire on the same run independently — one write, one report, per judge", async () => {
    const {
      value,
      applied,
      appliedMetadataAttribution,
      reports,
      metadataAttributionReports,
    } = ports({
      fetchRun: vi.fn(async () =>
        runRow({
          metadataAttributionJobId: "d7-job1",
          iterations: [
            // Graded by goal-completion only.
            runRow().iterations[0]!,
            // Graded by D7 only.
            { ...d7Row().iterations[0]!, iterationId: "iter2" },
          ],
        }),
      ),
    });
    const result = await runJudgeSecondPass("run1", value);

    expect(result.graded).toBe(2);
    expect(applied.map((a) => a.iterationId)).toEqual(["iter1"]);
    expect(appliedMetadataAttribution.map((a) => a.iterationId)).toEqual([
      "iter2",
    ]);
    expect(reports).toHaveLength(1);
    expect(metadataAttributionReports).toHaveLength(1);
  });

  test("a D7 write failure never blocks goal-completion's own write", async () => {
    const { value, applied, reports } = ports({
      fetchRun: vi.fn(async () =>
        runRow({
          metadataAttributionJobId: "d7-job1",
          iterations: [
            runRow().iterations[0]!,
            { ...d7Row().iterations[0]!, iterationId: "iter2" },
          ],
        }),
      ),
      applyMetadataAttributionDerivation: vi.fn(async () => {
        throw new JudgeStageBackendError(
          "conflict",
          409,
          "EVAL_RUN_CONFIG_CONFLICT",
        );
      }),
    });
    const result = await runJudgeSecondPass("run1", value);

    expect(applied).toHaveLength(1);
    expect(reports).toEqual([
      {
        runId: "run1",
        goalCompletionJobId: "job1",
        outcomes: [{ iterationId: "iter1", outcome: "applied" }],
      },
    ]);
    expect(result.metadataAttributionOutcomes).toEqual([]);
  });

  describe("one iteration carries both verdicts — each write stays behind its own gate", () => {
    // Same iteration, both a judgeVerdict AND a metadataAttributionVerdict
    // already saved — the scenario where a single shared derivation would
    // let a rejected write from one judge ride through the other's channel.
    const bothVerdictsRow = (over: Partial<JudgeSecondPassRunRow> = {}) =>
      runRow({
        metadataAttributionJobId: "d7-job1",
        iterations: [
          {
            ...runRow().iterations[0]!,
            prompts: d7Row().iterations[0]!.prompts,
            metadata: {
              ...runRow().iterations[0]!.metadata,
              ...d7Row().iterations[0]!.metadata,
            },
          },
        ],
        ...over,
      });

    test("both writes succeed: D7's write still carries goal-completion's confirmed userValue evidence", async () => {
      const { value, applied, appliedMetadataAttribution } = ports({
        fetchRun: vi.fn(async () => bothVerdictsRow()),
      });
      await runJudgeSecondPass("run1", value);

      expect(applied).toHaveLength(1);
      expect(appliedMetadataAttribution).toHaveLength(1);
      const goalBody = applied[0]!.body as Record<string, unknown>;
      const d7Body = appliedMetadataAttribution[0]!.body as Record<
        string,
        unknown
      >;
      // D7 recolored the shared failureCategory — goal-completion's write
      // never carries that, but D7's own write (landing after
      // goal-completion's is CONFIRMED) does not lose the userValue row
      // goal-completion just wrote either.
      expect(goalBody.failureCategory).not.toBe("metadata");
      expect(d7Body.failureCategory).toBe("metadata");
    });

    test("D7's write is rejected as stale: goal-completion's write never smuggles D7's recoloring", async () => {
      const { value, applied } = ports({
        fetchRun: vi.fn(async () => bothVerdictsRow()),
        applyMetadataAttributionDerivation: vi.fn(async () => {
          throw new JudgeStageBackendError(
            "stale",
            409,
            "EVAL_RUN_CONFIG_CONFLICT",
          );
        }),
      });
      await runJudgeSecondPass("run1", value);

      expect(applied).toHaveLength(1);
      const goalBody = applied[0]!.body as Record<string, unknown>;
      // The rejected D7 write's recoloring must not have reached the run
      // through goal-completion's still-valid channel.
      expect(goalBody.failureCategory).not.toBe("metadata");
    });

    // `userValue` is reached (not chain-broken) only when `selection`
    // itself hasn't failed — a different fixture than `bothVerdictsRow`
    // above, whose selection failure is exactly what gives D7 something to
    // recolor. This one splices D7's verdict onto the base `runRow` fixture
    // (which DOES reach `userValue`, per "the judge verdict reaches
    // userValue as a tier-2 row" above) so the userValue row's contents are
    // actually observable in D7's write body.
    const bothVerdictsReachableUserValueRow = (
      over: Partial<JudgeSecondPassRunRow> = {},
    ) =>
      runRow({
        metadataAttributionJobId: "d7-job1",
        iterations: [
          {
            ...runRow().iterations[0]!,
            metadata: {
              ...runRow().iterations[0]!.metadata,
              metadataAttributionVerdict: {
                status: "scored",
                attributed: true,
                reasons: ["unrelated to this iteration's selection"],
              },
            },
          },
        ],
        ...over,
      });

    test("goal-completion's write is rejected as stale: D7's write does not carry the rejected userValue conclusion", async () => {
      const { value: failValue, appliedMetadataAttribution: failedD7 } = ports({
        fetchRun: vi.fn(async () => bothVerdictsReachableUserValueRow()),
        applyDerivation: vi.fn(async () => {
          throw new JudgeStageBackendError(
            "stale",
            409,
            "EVAL_RUN_CONFIG_CONFLICT",
          );
        }),
      });
      await runJudgeSecondPass("run1", failValue);

      const { value: okValue, appliedMetadataAttribution: confirmedD7 } = ports(
        {
          fetchRun: vi.fn(async () => bothVerdictsReachableUserValueRow()),
        },
      );
      await runJudgeSecondPass("run1", okValue);

      expect(failedD7).toHaveLength(1);
      expect(confirmedD7).toHaveLength(1);
      const failedRows = (failedD7[0]!.body as Record<string, unknown>)
        .stageResults as Array<{ stage: string; state: string }>;
      const confirmedRows = (confirmedD7[0]!.body as Record<string, unknown>)
        .stageResults as Array<{ stage: string; state: string }>;
      const failedUserValue = failedRows.find((r) => r.stage === "userValue");
      const confirmedUserValue = confirmedRows.find(
        (r) => r.stage === "userValue",
      );
      // When goal-completion's own write is rejected in this pass, D7's
      // write must NOT carry goal-completion's `judgeFailed` conclusion —
      // it should read the same as an iteration with no judge verdict at
      // all reaching D7's write, not the confirmed (goal-completion write
      // succeeded) shape.
      expect(confirmedUserValue).toMatchObject({
        state: "failed",
        reason: "judgeFailed",
      });
      expect(failedUserValue?.reason).not.toBe("judgeFailed");
    });

    test("goal-completion's write RETURNS stale (not a thrown error): D7's write still does not carry it", async () => {
      // `stale` / `deferred` / `skipped_terminal` are normal RETURN VALUES
      // from applyDerivation, not exceptions — a job id that moved on is
      // reported the same way a genuinely applied write is. Only
      // `outcome: "applied"` means the derivation actually landed.
      const { value, appliedMetadataAttribution } = ports({
        fetchRun: vi.fn(async () => bothVerdictsReachableUserValueRow()),
        applyDerivation: vi.fn(async () => ({ outcome: "stale" as const })),
      });
      await runJudgeSecondPass("run1", value);

      expect(appliedMetadataAttribution).toHaveLength(1);
      const rows = (
        appliedMetadataAttribution[0]!.body as Record<string, unknown>
      ).stageResults as Array<{ stage: string; reason?: string }>;
      const userValueRow = rows.find((r) => r.stage === "userValue");
      expect(userValueRow?.reason).not.toBe("judgeFailed");
    });
  });
});

// =============================================================================
// CodeRabbit review — four findings, each pinned by the case that would have
// caught it. None of these files are type-checked by any script or by CI
// (`npm run typecheck` covers the SDK and sibling workspaces, not
// `mcpjam-inspector`), so two of the four were type errors that shipped green.
// Tests are the only guard these files actually have.
// =============================================================================
describe("the second pass keeps its contract with the run and the first pass", () => {
  test("an off run returns the FULL result shape, not a partial literal", async () => {
    // `JudgeSecondPassResult` requires `metadataAttributionOutcomes`. The
    // off/shadow path built its own literal and omitted it — for most runs.
    process.env[ENV_KEY] = "dual_write";
    const { value } = ports({
      fetchRun: vi.fn(async () => ({
        ...runRow(),
        configSnapshot: { gradingEngine: { mode: "off" } },
      })),
    });

    const result = await runJudgeSecondPass("run1", value);

    expect(result.reason).toBe("mode_off");
    expect(result.metadataAttributionOutcomes).toEqual([]);
    expect(result.outcomes).toEqual([]);
  });

  test("a stampless legacy row still derives, through stageCase", async () => {
    // The fallback the row type had stopped declaring. A backend row carrying
    // only the derived shape must still produce a chain.
    const { value, applied } = ports({
      fetchRun: vi.fn(async () => {
        const row = runRow();
        return {
          ...row,
          iterations: row.iterations.map(
            ({ authoredCase: _drop, ...rest }) => ({
              ...rest,
              stageCase,
            }),
          ),
        };
      }),
    });

    await runJudgeSecondPass("run1", value);

    expect(applied[0]?.body?.stageResults).toBeDefined();
  });

  test("a legacy widget_probe with no turns stays MODEL-FREE", async () => {
    // `isPinnedOnly` calls a zero-turn `widget_probe` model-free on the first
    // pass. `isModelFree(undefined)` is `false`, so deriving from `steps` here
    // would call it model-driven and invent a `selection` stage — and this
    // post overwrites `stageResults` wholesale, replacing a correct chain.
    const { value, applied } = ports({
      fetchRun: vi.fn(async () => {
        const row = runRow();
        return {
          ...row,
          iterations: row.iterations.map((iteration) => ({
            ...iteration,
            authoredCase: { caseType: "widget_probe", expectedOutput: "done" },
          })),
        };
      }),
    });

    await runJudgeSecondPass("run1", value);

    const stages = (applied[0]?.body?.stageResults ?? []) as Array<{
      stage?: string;
      state?: string;
    }>;
    const selection = stages.find((row) => row.stage === "selection");
    // Either absent, or present and explicitly not-applicable — never a real
    // selection verdict the first pass would not have produced.
    expect(selection === undefined || selection.state === "notApplicable").toBe(
      true,
    );
  });
});

/**
 * B10e — the judge's ROLE reaches the score definition this pass projects.
 *
 * The pass forwards `metadata.judgeVerdict` whole, so the role rides along
 * without a second mapping to keep true. What is worth pinning is the
 * consequence: on a gating run the projected definition gates, and on every
 * other run — including one whose verdict carries the field explicitly as
 * advisory — the rows are byte-identical to what this pass has always written.
 *
 * It still touches no verdict. This pass posts rows; `finalizeAfterJudge`
 * applies them, stricter-only, and decides the run once.
 */
describe("the projected judge definition carries the run's role", () => {
  function withRole(role?: string) {
    return vi.fn(async () => {
      const row = runRow();
      return {
        ...row,
        iterations: row.iterations.map((iteration) => ({
          ...iteration,
          metadata: {
            judgeVerdict: {
              ...(iteration.metadata as { judgeVerdict: object }).judgeVerdict,
              ...(role !== undefined ? { role } : {}),
            },
          },
        })),
      };
    });
  }

  function judgeDefinition(body: JudgeStageDerivationBody) {
    const config = body.evaluationConfig as
      { definitions?: Array<Record<string, unknown>> } | undefined;
    return config?.definitions?.find(
      (definition) => definition.scorerId === "judge:goalCompletion",
    );
  }

  function judgeRow(body: JudgeStageDerivationBody) {
    return (body.scores as Array<Record<string, unknown>> | undefined)?.find(
      (row) => row.scorerId === "judge:goalCompletion",
    );
  }

  test("a required verdict projects a required definition and a failing row", async () => {
    const { value, applied } = ports({ fetchRun: withRole("gating") });
    await runJudgeSecondPass("run1", value);

    const body = applied[0]!.body;
    expect(judgeDefinition(body)?.role).toBe(authoredRequiredRole());
    // The judge scored 0.2 against a 0.8 threshold, so the row fails — and on
    // a gating definition that row now counts.
    expect(judgeRow(body)?.passed).toBe(false);
    // ...while this pass still touches no lifecycle field. The backend refuses
    // them on this route outright, and the finalizer is what applies the row.
    expect(body).not.toHaveProperty("status");
    expect(body).not.toHaveProperty("result");
    expect(body).not.toHaveProperty("passed");
  });

  test("both spellings of a required verdict project one definition", async () => {
    // The backend stamped `"gating"` before the rename and stamps `"required"`
    // after it, and this pass reads historical evidence. The projection has to
    // read both, or every hosted judge on one side of that line stops gating.
    const legacy = ports({ fetchRun: withRole("gating") });
    await runJudgeSecondPass("run1", legacy.value);
    const canonical = ports({ fetchRun: withRole("required") });
    await runJudgeSecondPass("run1", canonical.value);
    expect(judgeDefinition(canonical.applied[0]!.body)).toEqual(
      judgeDefinition(legacy.applied[0]!.body),
    );
  });

  test("an advisory verdict is byte-identical with or without the field", async () => {
    const absent = ports({ fetchRun: withRole(undefined) });
    await runJudgeSecondPass("run1", absent.value);
    const explicit = ports({ fetchRun: withRole("advisory") });
    await runJudgeSecondPass("run1", explicit.value);

    // `judgeStageDerivedAt` is `Date.now()` at the moment each pass ran, so
    // the two differ whenever the second pass lands in a later millisecond —
    // which under a loaded suite it sometimes does. It is asserted as a number
    // and then set aside, the same way the shape test above treats it; what
    // this test is about is everything else being identical.
    const withoutClock = (body: JudgeStageDerivationBody) => {
      const { judgeStageDerivedAt, ...rest } = body as Record<string, unknown>;
      expect(typeof judgeStageDerivedAt).toBe("number");
      return rest;
    };

    expect(withoutClock(explicit.applied[0]!.body)).toEqual(
      withoutClock(absent.applied[0]!.body),
    );
    expect(judgeDefinition(absent.applied[0]!.body)?.role).toBe("advisory");
  });
});

/**
 * The tool-call definition must survive the second pass for every way a case
 * can author its expectations, not only the legacy top-level list.
 *
 * The first pass declares `toolCalls:match` from what the MATCHER was handed,
 * and the matcher is handed the turns the runner resolves: from `steps` when
 * the case has them, which is where a steps-authored case keeps its
 * expectations. Its top-level `expectedToolCalls` is absent. A second pass that
 * reads only that list drops the definition, while the backend keeps the first
 * pass's row (rows merge by `scorerId`, `evaluationConfig` is replaced
 * wholesale). The row is then orphaned and score integrity reads invalid.
 *
 * Asserted as a JOIN against the real first pass, not as "the id is present":
 * a definition under the wrong `definitionHash` is the same orphan.
 */
describe("a steps-authored case keeps its tool-call definition through the second pass", () => {
  const matchOptions = {
    toolCallOrder: "ignore" as const,
    maxExtraToolCalls: null,
  };
  const judgeVerdict = {
    status: "scored",
    verdict: "pass",
    score: 0.9,
    threshold: 0.8,
    judgeTemplateVersion: 2,
    judgeTemplateHash: "tpl",
    model: "gpt-x",
  };

  const promptStep = (id: string, prompt: string) => ({
    id,
    kind: "prompt" as const,
    prompt,
  });
  const expectCall = (id: string, toolName: string, role?: "advisory") => ({
    id,
    kind: "assert" as const,
    assertion: {
      type: "toolCalledWith",
      toolName,
      args: { args: {} },
      ...(role ? { role } : {}),
    },
  });

  type Authored = {
    steps?: unknown[];
    query?: string;
    expectedToolCalls?: unknown[];
    isNegativeTest?: boolean;
  };

  /** The runner's first pass, end to end, over the turns it resolves. */
  function firstPass(authored: Authored) {
    const turns = authored.steps
      ? stepsToPromptTurns(normalizeSteps(authored.steps))
      : resolvePromptTurns(authored);
    const evaluation = evaluateMultiTurnResults(
      turns,
      // Every expected call was made, so the row is a pass: the failure this
      // guards is the join, not the verdict.
      turns.map((turn) => turn.expectedToolCalls),
      authored.isNegativeTest,
      matchOptions,
    );
    const params = buildIterationFinishParams({
      iterationId: "iter1",
      runId: "run1",
      passed: evaluation.passed,
      evaluation,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      messages: [{ role: "user", content: "hi" }],
      status: "completed",
      startedAt: 0,
      iterationMetadataBase: {},
      gradingMode: "dual_write",
      scoreMatchOptions: matchOptions,
      ...(authored.isNegativeTest ? { isNegativeTest: true } : {}),
    } as unknown as Parameters<typeof buildIterationFinishParams>[0]);
    return params.metadata as {
      scores?: Array<{ scorerId: string; definitionHash: string }>;
      evaluationConfig?: { definitions: ResolvedScoreDefinition[] };
    } & Record<string, unknown>;
  }

  async function secondPass(authored: Authored) {
    const first = firstPass(authored);
    const { value, applied } = ports({
      fetchRun: vi.fn(async () =>
        runRow({
          iterations: [
            {
              iterationId: "iter1",
              status: "completed",
              authoredCase: authored as never,
              matchOptions,
              ...(authored.isNegativeTest ? { isNegativeTest: true } : {}),
              messages: [{ role: "user", content: "hi" }],
              metadata: { ...first, judgeVerdict },
            },
          ],
        }),
      ),
    });
    await runJudgeSecondPass("run1", value);
    const body = applied[0]!.body;
    return {
      first,
      scores: (body.scores ?? []) as Array<{
        scorerId: string;
        definitionHash: string;
      }>,
      config: body.evaluationConfig as
        { definitions: ResolvedScoreDefinition[] } | undefined,
    };
  }

  /** What the backend stores after the post: rows merged by id, config replaced. */
  function mergedRowsJoin(result: Awaited<ReturnType<typeof secondPass>>) {
    const replaced = new Set(result.scores.map((row) => row.scorerId));
    const merged = [
      ...(result.first.scores ?? []).filter(
        (row) => !replaced.has(row.scorerId),
      ),
      ...result.scores,
    ];
    const hashes = new Set(
      (result.config?.definitions ?? []).map((d) => definitionHash(d)),
    );
    return merged.filter((row) => !hashes.has(row.definitionHash));
  }

  const toolMatchIds = (definitions?: ResolvedScoreDefinition[]) =>
    (definitions ?? [])
      .map((definition) => definition.scorerId)
      .filter((id) => id === HOSTED_TOOL_MATCH_SCORER_ID);

  test("keeps a toolCalls:match definition that joins the first-pass row", async () => {
    const result = await secondPass({
      steps: [
        promptStep("p1", "list my files"),
        expectCall("a1", "list_files"),
      ],
    });

    // The first pass really did write the row this is about.
    expect(result.first.scores?.map((row) => row.scorerId)).toContain(
      HOSTED_TOOL_MATCH_SCORER_ID,
    );
    expect(toolMatchIds(result.config?.definitions)).toEqual([
      HOSTED_TOOL_MATCH_SCORER_ID,
    ]);
    expect(mergedRowsJoin(result)).toEqual([]);
  });

  test("keeps it when only a LATER turn expects a call", async () => {
    // The matcher flattens every turn's expectations, so the first pass
    // declares the scorer here. Reading only the first turn would not.
    const result = await secondPass({
      steps: [
        promptStep("p1", "hello"),
        promptStep("p2", "now list my files"),
        expectCall("a2", "list_files"),
      ],
    });

    expect(toolMatchIds(result.first.evaluationConfig?.definitions)).toEqual([
      HOSTED_TOOL_MATCH_SCORER_ID,
    ]);
    expect(toolMatchIds(result.config?.definitions)).toEqual([
      HOSTED_TOOL_MATCH_SCORER_ID,
    ]);
    expect(mergedRowsJoin(result)).toEqual([]);
  });

  test("a legacy top-level case still keeps it", async () => {
    const result = await secondPass({
      query: "list my files",
      expectedToolCalls: [{ toolName: "list_files", arguments: {} }],
    });

    expect(toolMatchIds(result.config?.definitions)).toEqual([
      HOSTED_TOOL_MATCH_SCORER_ID,
    ]);
    expect(mergedRowsJoin(result)).toEqual([]);
  });

  test.each([
    [
      "an advisory toolCalledWith (a predicate, not a matcher expectation)",
      {
        steps: [
          promptStep("p1", "hi"),
          expectCall("a1", "list_files", "advisory"),
        ],
      },
    ],
    [
      "a pinned toolCall step (fixture input, exempt from matching)",
      {
        steps: [
          {
            id: "t1",
            kind: "toolCall",
            serverName: "files",
            toolName: "list_files",
            arguments: {},
          },
          expectCall("a1", "list_files"),
        ],
      },
    ],
    [
      "a negative test",
      {
        isNegativeTest: true,
        steps: [promptStep("p1", "do nothing"), expectCall("a1", "list_files")],
      },
    ],
  ])(
    "declares no definition the first pass did not: %s",
    async (_label, authored) => {
      const result = await secondPass(authored);

      expect(toolMatchIds(result.first.evaluationConfig?.definitions)).toEqual(
        [],
      );
      // A definition with no row is not harmless either: a GATING one reads as
      // unresolved at `enforce` and fails the trial on evidence nobody took.
      expect(toolMatchIds(result.config?.definitions)).toEqual([]);
      expect(mergedRowsJoin(result)).toEqual([]);
    },
  );
});

/**
 * A run finalized by one build and judged by the next.
 *
 * The tool-call rows are the FIRST pass's: this pass has no matcher output and
 * never re-posts them. So the definitions it declares for them must be the
 * ones those rows were minted against, not this build's — or a run that
 * straddles the deploy that split `toolCalls:arguments` out of
 * `toolCalls:match` loses its route row to a new hash and gains a gating
 * definition with no row at all.
 */
describe("the second pass declares the tool-call scorers the first pass stored", () => {
  const judgeVerdict = {
    status: "scored",
    verdict: "pass",
    score: 0.9,
    threshold: 0.8,
    judgeTemplateVersion: 2,
    judgeTemplateHash: "tpl",
    model: "gpt-x",
  };
  const matchOptions = {
    toolCallOrder: "ignore",
    maxExtraToolCalls: null,
    argumentMatching: "partial",
  };

  async function judge(stored: {
    evaluationConfig: { definitions: ResolvedScoreDefinition[] };
    scores: Array<{ scorerId: string; definitionHash: string }>;
  }) {
    const { value, applied } = ports({
      fetchRun: vi.fn(async () =>
        runRow({
          iterations: [
            {
              iterationId: "iter1",
              status: "completed",
              authoredCase: {
                query: "list my files",
                expectedToolCalls: [{ toolName: "list_files", arguments: {} }],
              } as never,
              matchOptions,
              messages: [{ role: "user", content: "hi" }],
              metadata: { ...stored, judgeVerdict },
            },
          ],
        }),
      ),
    });
    await runJudgeSecondPass("run1", value);
    const body = applied[0]!.body;
    const config = body.evaluationConfig as {
      definitions: ResolvedScoreDefinition[];
    };
    const posted = (body.scores ?? []) as Array<{
      scorerId: string;
      definitionHash: string;
    }>;
    // What the backend keeps: rows merged by id, the config replaced.
    const replaced = new Set(posted.map((row) => row.scorerId));
    const merged = [
      ...stored.scores.filter((row) => !replaced.has(row.scorerId)),
      ...posted,
    ];
    const hashes = new Set(config.definitions.map((d) => definitionHash(d)));
    return {
      config,
      orphans: merged.filter((row) => !hashes.has(row.definitionHash)),
      rowless: config.definitions.filter(
        (d) =>
          d.role !== "advisory" &&
          !merged.some((row) => row.definitionHash === definitionHash(d)),
      ),
    };
  }

  test("a run finalized before the split keeps its v2 route row and gains no arguments scorer", async () => {
    // The v2 definition and row exactly as the previous build minted them.
    const v2 = {
      scorerId: HOSTED_TOOL_MATCH_SCORER_ID,
      idSource: "platform",
      scorerVersion: "2",
      implementationHash: canonicalDigest({
        evaluatorVersion: "2",
        matchOptions,
      }),
      label: "expected tool calls",
      deterministic: true,
      passThreshold: 1,
      role: authoredRequiredRole(),
    } as const;
    const stored = buildEvaluationConfigSnapshot([v2]);
    const row = fromCriterionResult(stored.definitions[0]!, {
      criterionId: HOSTED_TOOL_MATCH_SCORER_ID,
      passed: false,
      reason: "tool-call expectations unmet: 1 argument mismatch(es)",
    });

    const result = await judge({
      evaluationConfig: stored,
      scores: [row],
    });

    const tools = result.config.definitions.filter((d) =>
      d.scorerId.startsWith("toolCalls:"),
    );
    expect(tools).toEqual(stored.definitions);
    expect(result.orphans).toEqual([]);
    // Above all, no gating definition the run has no row for.
    expect(result.rowless).toEqual([]);
  });

  test("a run finalized after it keeps both halves, as stored", async () => {
    const first = buildHostedScoreContract({
      evaluation: {
        passed: false,
        expectedToolCalls: [{ toolName: "list_files", arguments: { a: 1 } }],
        missing: [],
        unexpected: [],
        argumentMismatches: [
          {
            toolName: "list_files",
            expectedArgs: { a: 1 },
            actualArgs: { a: 2 },
          },
        ],
      },
      matchOptions,
    });

    const result = await judge({
      evaluationConfig: first.evaluationConfig,
      scores: first.scores,
    });

    expect(
      result.config.definitions
        .filter((d) => d.scorerId.startsWith("toolCalls:"))
        .map((d) => d.scorerId)
        .sort(),
    ).toEqual([HOSTED_TOOL_ARGUMENTS_SCORER_ID, HOSTED_TOOL_MATCH_SCORER_ID]);
    expect(result.orphans).toEqual([]);
    expect(result.rowless).toEqual([]);
  });
});

describe("the marker carries what the chain cannot", () => {
  // The case the chain-scan recovery could never see, and the reason the
  // classification is now persisted rather than inferred.
  //
  // `categoryFor` returns `setup` for a model-call failure where NOTHING
  // failed — "there was nothing to fail against". On that shape
  // `applyProviderError` relabels no row, so a recovery that looks for a
  // `providerError` row finds an empty chain and concludes the provider was
  // fine. The category then vanishes on the second pass with no missing row to
  // point at.
  const reachedAndPassed = {
    status: "completed",
    traceComplete: true,
    stageCase: {
      mode: "model_driven",
      expectsToolCall: false,
      expectsWidgetRender: false,
      assertionCount: 0,
    },
    spans: [{ id: "s1", name: "tools/call", category: "tool", status: "ok" }],
  };

  const derive = (metadata: Record<string, unknown>) =>
    deriveIterationPayload({
      iteration: { ...reachedAndPassed, metadata },
      mode: "advisory",
      judgeVerdict: { status: "scored", verdict: "pass", score: 0.9 },
      attributionVerdict: undefined,
    } as never).stage;

  // Nothing failed, and nothing blamed on the provider — exactly what the
  // first pass writes for this shape.
  const CLEAN_CHAIN = [
    { stage: "connection", state: "passed", reason: "observed" },
  ];

  it("keeps the setup category when NO row records providerError", () => {
    const stage = derive({
      stageResults: CLEAN_CHAIN,
      stageStepErrorSource: "model",
    });
    expect(stage.failureCategory).toBe("setup");
  });

  it("and the chain alone cannot recover it — the reason the marker exists", () => {
    // Same chain, marker absent. This is what the second pass saw before, and
    // it is why the old recovery's "if and only if" premise was false.
    expect(stepErrorFromStoredChain(CLEAN_CHAIN)).toBeUndefined();
    const stage = derive({ stageResults: CLEAN_CHAIN });
    expect(stage.failureCategory).toBeUndefined();
  });

  it("does not invent a provider failure from a marker saying otherwise", () => {
    expect(
      derive({ stageResults: CLEAN_CHAIN, stageStepErrorSource: "setup" })
        .failureCategory,
    ).toBeUndefined();
  });
});


describe("stepErrorFromStoredChain", () => {
  // `stepError` is an INPUT to the first derivation and is never persisted, so
  // the judge pass re-derived without it and dropped `providerError` and the
  // `setup` category the moment a verdict landed — a run our own provider
  // killed went back to being filed against the server.

  it("recovers the model layer from a chain that recorded providerError", () => {
    expect(
      stepErrorFromStoredChain([
        { stage: "connection", state: "passed", reason: "observed" },
        { stage: "selection", state: "notMeasured", reason: "providerError" },
      ]),
    ).toEqual({ source: "model" });
  });

  it("recovers nothing from a chain that recorded no provider failure", () => {
    // The witness has to be the reason itself. Inferring a provider error from
    // any other blank row would re-introduce the guess this reason removed.
    expect(
      stepErrorFromStoredChain([
        { stage: "selection", state: "notMeasured", reason: "noEvidenceCaptured" },
        { stage: "userValue", state: "failed", reason: "predicateFailed" },
      ]),
    ).toBeUndefined();
  });

  it("recovers nothing when there is no chain at all", () => {
    expect(stepErrorFromStoredChain(undefined)).toBeUndefined();
    expect(stepErrorFromStoredChain([])).toBeUndefined();
    expect(stepErrorFromStoredChain("not an array")).toBeUndefined();
  });
});

describe("the recovery is WIRED into the re-derivation", () => {
  // Testing `stepErrorFromStoredChain` alone cannot fail when the wire is cut,
  // and a cut wire is exactly how this attribution kept getting lost. So this
  // drives the real payload builder and asserts the re-derived chain still
  // says the model layer failed.
  //
  // The fixture is the SHAPE a provider failure actually leaves: the server was
  // reached (spans exist, so connection and discovery are implied) and then our
  // model call died, leaving the stages after it blank. An iteration with no
  // evidence at all derives to `setupAborted`, which is a more specific reason
  // and correctly outranks `providerError` — so it would prove nothing here.
  const reachedThenDied = {
    status: "failed",
    traceComplete: true,
    stageCase: {
      mode: "model_driven",
      expectsToolCall: false,
      expectsWidgetRender: false,
      assertionCount: 0,
    },
    spans: [{ id: "s1", name: "tools/call", category: "tool", status: "ok" }],
  };

  const derive = (stageResults: unknown) =>
    deriveIterationPayload({
      iteration: { ...reachedThenDied, metadata: { stageResults } },
      mode: "advisory",
      judgeVerdict: { status: "scored", verdict: "fail", score: 0.1 },
      attributionVerdict: undefined,
    } as never).stage;

  const reasons = (stage: Record<string, unknown>) =>
    (stage.stageResults as { reason: string }[]).map((r) => r.reason);

  it("keeps providerError and the setup category through a judge pass", () => {
    const stage = derive([
      { stage: "selection", state: "notMeasured", reason: "providerError" },
    ]);
    expect(reasons(stage)).toContain("providerError");
    expect(stage.failureCategory).toBe("setup");
  });

  it("does not invent a provider failure on a run that had none", () => {
    // The same evidence, a stored chain that never blamed the provider. The
    // blank stage stays blank rather than acquiring an attribution the first
    // derivation did not make.
    const stage = derive([
      { stage: "selection", state: "notMeasured", reason: "noEvidenceCaptured" },
    ]);
    expect(reasons(stage)).not.toContain("providerError");
  });
});

describe("stepErrorFromStoredChain", () => {
  // `stepError` is an INPUT to the first derivation and is never persisted, so
  // the judge pass re-derived without it and dropped `providerError` and the
  // `setup` category the moment a verdict landed — a run our own provider
  // killed went back to being filed against the server.

  it("recovers the model layer from a chain that recorded providerError", () => {
    expect(
      stepErrorFromStoredChain([
        { stage: "connection", state: "passed", reason: "observed" },
        { stage: "selection", state: "notMeasured", reason: "providerError" },
      ]),
    ).toEqual({ source: "model" });
  });

  it("recovers nothing from a chain that recorded no provider failure", () => {
    // The witness has to be the reason itself. Inferring a provider error from
    // any other blank row would re-introduce the guess this reason removed.
    expect(
      stepErrorFromStoredChain([
        { stage: "selection", state: "notMeasured", reason: "noEvidenceCaptured" },
        { stage: "userValue", state: "failed", reason: "predicateFailed" },
      ]),
    ).toBeUndefined();
  });

  it("recovers nothing when there is no chain at all", () => {
    expect(stepErrorFromStoredChain(undefined)).toBeUndefined();
    expect(stepErrorFromStoredChain([])).toBeUndefined();
    expect(stepErrorFromStoredChain("not an array")).toBeUndefined();
  });
});

describe("the recovery is WIRED into the re-derivation", () => {
  // Testing `stepErrorFromStoredChain` alone cannot fail when the wire is cut,
  // and a cut wire is exactly how this attribution kept getting lost. So this
  // drives the real payload builder and asserts the re-derived chain still
  // says the model layer failed.
  //
  // The fixture is the SHAPE a provider failure actually leaves: the server was
  // reached (spans exist, so connection and discovery are implied) and then our
  // model call died, leaving the stages after it blank. An iteration with no
  // evidence at all derives to `setupAborted`, which is a more specific reason
  // and correctly outranks `providerError` — so it would prove nothing here.
  const reachedThenDied = {
    status: "failed",
    traceComplete: true,
    stageCase: {
      mode: "model_driven",
      expectsToolCall: false,
      expectsWidgetRender: false,
      assertionCount: 0,
    },
    spans: [{ id: "s1", name: "tools/call", category: "tool", status: "ok" }],
  };

  const derive = (stageResults: unknown) =>
    deriveIterationPayload({
      iteration: { ...reachedThenDied, metadata: { stageResults } },
      mode: "advisory",
      judgeVerdict: { status: "scored", verdict: "fail", score: 0.1 },
      attributionVerdict: undefined,
    } as never).stage;

  const reasons = (stage: Record<string, unknown>) =>
    (stage.stageResults as { reason: string }[]).map((r) => r.reason);

  it("keeps providerError and the setup category through a judge pass", () => {
    const stage = derive([
      { stage: "selection", state: "notMeasured", reason: "providerError" },
    ]);
    expect(reasons(stage)).toContain("providerError");
    expect(stage.failureCategory).toBe("setup");
  });

  it("does not invent a provider failure on a run that had none", () => {
    // The same evidence, a stored chain that never blamed the provider. The
    // blank stage stays blank rather than acquiring an attribution the first
    // derivation did not make.
    const stage = derive([
      { stage: "selection", state: "notMeasured", reason: "noEvidenceCaptured" },
    ]);
    expect(reasons(stage)).not.toContain("providerError");
  });
});
