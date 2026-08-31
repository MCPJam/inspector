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
        runRow({ configSnapshot: { gradingEngine: { mode: "shadow" } } }),
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
    expect(value.markFanout).not.toHaveBeenCalled();
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
    expect(reports).toHaveLength(0);
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
