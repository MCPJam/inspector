import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ModelMessage } from "ai";
import type { Predicate } from "@mcpjam/sdk/predicates";
import { buildIterationFinishParams } from "../finalize-iteration.js";
import {
  buildHostedScoreContract,
  shadowVerdictFromScores,
} from "../score-rows.js";
import { HOSTED_JUDGE_SCORER_ID } from "../score-definitions.js";
import { allGatingScorersPassed } from "@mcpjam/sdk/contract";
import {
  MAX_SHADOW_MISMATCHES_PER_RUN,
  buildShadowMismatch,
  emitShadowMismatch,
  resetShadowMismatchStateForTests,
} from "../shadow-mismatch.js";
import { logger } from "../../../utils/logger.js";

// =============================================================================
// The mode gate, from the outside. The three properties that make "ships at
// off" a fact rather than a claim:
//
//   off        → the persisted payload is BYTE-IDENTICAL to today's,
//   shadow     → exactly two extra keys, both `*Shadow`,
//   dual_write → exactly two extra keys, both real,
//
// plus the telemetry rule that makes shadow mode readable: agreement emits
// NOTHING, so a mismatch row is always a real disagreement.
// =============================================================================

const ENV_KEY = "MCPJAM_GRADING_ENGINE_MODE";
const originalEnv = process.env[ENV_KEY];

const usageZero = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
const messages: ModelMessage[] = [{ role: "user", content: "hi" }];

const predicate: Predicate = {
  type: "tool_called",
  toolName: "list_files",
} as unknown as Predicate;

const evaluation = {
  passed: true,
  toolsCalled: ["list_files"],
  turnCount: 1,
  failedTurnCount: 0,
  expectedToolCalls: ["list_files"],
  missing: [],
  unexpected: [],
  argumentMismatches: [],
};

const predicateResults = [{ predicate, passed: true }];

function build(over: Record<string, unknown> = {}) {
  return buildIterationFinishParams({
    iterationId: "iter1",
    runId: "run1",
    passed: true,
    evaluation,
    usage: usageZero,
    messages,
    status: "completed",
    startedAt: 0,
    iterationMetadataBase: {},
    predicateResults,
    ...over,
  } as Parameters<typeof buildIterationFinishParams>[0]);
}

const metadataOf = (params: ReturnType<typeof build>) =>
  params.metadata as Record<string, unknown>;

afterEach(() => {
  if (originalEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = originalEnv;
  resetShadowMismatchStateForTests();
  vi.restoreAllMocks();
});

beforeEach(() => {
  delete process.env[ENV_KEY];
  resetShadowMismatchStateForTests();
});

describe("mode gate on the persisted payload", () => {
  test("off is byte-identical to the payload with no mode at all", () => {
    const today = JSON.stringify(build());
    const off = JSON.stringify(build({ gradingMode: "off" }));
    expect(off).toBe(today);
  });

  test("off writes no score keys, shadow-flavoured or otherwise", () => {
    const metadata = metadataOf(build({ gradingMode: "off" }));
    for (const key of [
      "scores",
      "evaluationConfig",
      "scoresShadow",
      "evaluationConfigShadow",
    ]) {
      expect(metadata).not.toHaveProperty(key);
    }
  });

  test("shadow adds only the two shadow keys", () => {
    const base = metadataOf(build({ gradingMode: "off" }));
    const shadow = metadataOf(build({ gradingMode: "shadow" }));
    const added = Object.keys(shadow).filter((key) => !(key in base));
    expect(added.sort()).toEqual(["evaluationConfigShadow", "scoresShadow"]);
    // Everything the runner already persisted is untouched.
    for (const [key, value] of Object.entries(base)) {
      expect(JSON.stringify(shadow[key])).toBe(JSON.stringify(value));
    }
  });

  test("dual_write adds only the two real keys", () => {
    const base = metadataOf(build({ gradingMode: "off" }));
    const dual = metadataOf(build({ gradingMode: "dual_write" }));
    const added = Object.keys(dual).filter((key) => !(key in base));
    expect(added.sort()).toEqual(["evaluationConfig", "scores"]);
    for (const [key, value] of Object.entries(base)) {
      expect(JSON.stringify(dual[key])).toBe(JSON.stringify(value));
    }
  });

  test("the verdict is the same object in every mode", () => {
    const verdicts = (["off", "shadow", "dual_write"] as const).map((mode) =>
      JSON.stringify(build({ gradingMode: mode }).result)
    );
    expect(new Set(verdicts).size).toBe(1);
  });

  test("the env var alone is enough to keep a caller-less path off", () => {
    process.env[ENV_KEY] = "off";
    const metadata = metadataOf(build());
    expect(metadata).not.toHaveProperty("scores");
    expect(metadata).not.toHaveProperty("scoresShadow");
  });

  test("shadow rows carry a resolvable config: every row joins a definition", () => {
    const metadata = metadataOf(build({ gradingMode: "shadow" }));
    const scores = metadata.scoresShadow as Array<{ scorerId: string }>;
    const config = metadata.evaluationConfigShadow as {
      definitions: Array<{ scorerId: string }>;
    };
    const ids = new Set(config.definitions.map((d) => d.scorerId));
    expect(scores.length).toBeGreaterThan(0);
    for (const score of scores) expect(ids.has(score.scorerId)).toBe(true);
  });

  test("the first pass never projects a judge row (the judge has not run)", () => {
    const metadata = metadataOf(build({ gradingMode: "dual_write" }));
    const scores = metadata.scores as Array<{ scorerId: string }>;
    expect(scores.some((s) => s.scorerId === HOSTED_JUDGE_SCORER_ID)).toBe(
      false
    );
  });
});

describe("shadow telemetry: silence is the success signal", () => {
  test("an agreeing iteration emits nothing at all", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    build({ gradingMode: "shadow" });
    build({ gradingMode: "dual_write" });
    expect(warn).toHaveBeenCalledTimes(0);
  });

  test("a disagreement emits exactly one row", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    build({
      gradingMode: "shadow",
      // The authoritative verdict says pass; the projected gating rows say fail.
      passed: true,
      predicateResults: [{ predicate, passed: false }],
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe("grading_shadow_mismatch");
  });

  test("the payload is content-free and carries the reproducibility keys", () => {
    const mismatch = buildShadowMismatch(
      {
        runId: "run1",
        iterationId: "iter1",
        caseKey: "the user's private case title",
        passed: true,
        userValue: { state: "passed", reason: "observed" },
      },
      {
        passed: false,
        mode: "shadow",
        disagreeingScorerIds: ["predicate:tool_called-abc"],
        definitionHash: "d1",
        evaluationConfigHash: "c1",
        judgeTemplateVersion: 2,
        judgeTemplateHash: "t1",
        stageAnalyzerVersion: 3,
      }
    );
    expect(mismatch).toBeDefined();
    const serialized = JSON.stringify(mismatch);
    expect(serialized).not.toContain("the user's private case title");
    expect(mismatch).toMatchObject({
      mismatchKind: "legacyPassedShadowFailed",
      legacyPassed: true,
      shadowPassed: false,
      definitionHash: "d1",
      evaluationConfigHash: "c1",
      judgeTemplateVersion: 2,
      judgeTemplateHash: "t1",
      stageAnalyzerVersion: 3,
      mode: "shadow",
    });
    expect(mismatch?.caseKeyHash).toMatch(/^[0-9a-f]{64}$/);
    for (const forbidden of [
      "caseKey",
      "rationale",
      "evidence",
      "expectedOutput",
      "transcript",
      "prompts",
      "serverUrl",
    ]) {
      expect(mismatch).not.toHaveProperty(forbidden);
    }
  });

  test("agreement returns undefined even when the rows differ in shape", () => {
    expect(
      buildShadowMismatch(
        {
          runId: "r",
          iterationId: "i",
          passed: true,
          userValue: { state: "passed", reason: "observed" },
        },
        {
          passed: true,
          mode: "shadow",
          userValue: { state: "passed", reason: "observed" },
        }
      )
    ).toBeUndefined();
  });

  test("a moved userValue row is reported even when the verdicts agree", () => {
    expect(
      buildShadowMismatch(
        {
          runId: "r",
          iterationId: "i",
          passed: false,
          userValue: { state: "notMeasured", reason: "noEvidenceCaptured" },
        },
        {
          passed: false,
          mode: "shadow",
          userValue: { state: "failed", reason: "judgeFailed" },
        }
      )?.mismatchKind
    ).toBe("userValueRowChanged");
  });

  test("dedupes by (runId, iterationId, mismatchKind) and caps per run", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const mismatch = buildShadowMismatch(
      { runId: "run1", iterationId: "iter1", passed: true },
      { passed: false, mode: "shadow" }
    );
    expect(emitShadowMismatch(mismatch)).toBe(true);
    expect(emitShadowMismatch(mismatch)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);

    for (let index = 0; index < MAX_SHADOW_MISMATCHES_PER_RUN + 5; index += 1) {
      emitShadowMismatch(
        buildShadowMismatch(
          { runId: "run1", iterationId: `extra-${index}`, passed: true },
          { passed: false, mode: "shadow" }
        )
      );
    }
    const names = warn.mock.calls.map((call) => call[0]);
    expect(names.filter((n) => n === "grading_shadow_mismatch")).toHaveLength(
      MAX_SHADOW_MISMATCHES_PER_RUN
    );
    // Exactly one truncation notice, no matter how many were dropped.
    expect(
      names.filter((n) => n === "grading_shadow_mismatch_truncated")
    ).toHaveLength(1);
  });

  test("undefined is a no-op, so callers need no agreement branch", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    expect(emitShadowMismatch(undefined)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(0);
  });
});

// =============================================================================
// B10e — THE JUDGE'S ROLE COMES FROM THE VERDICT.
//
// The projection used to hard-code the judge advisory, which made a gating
// judge structurally powerless: a suite could earn the gate, the backend could
// hold the run for it, and this file would still emit a row the gate
// arithmetic never looks at. The role now travels on
// `metadata.judgeVerdict.role`, stamped by the backend from the run's frozen
// config.
//
// The decision is CLOSED and fails closed. Only the literal "gating" gates;
// absent, "advisory", and anything else — a future spelling, the wrong case —
// are advisory, because the default here decides whether a judge may fail
// somebody's build.
// =============================================================================
/**
 * The advisory judge's `definitionHash`, pinned.
 *
 * Stamped on every hosted iteration ever recorded, and the join key between a
 * stored row and its stored definition. A change here re-fingerprints all of
 * them; if this literal has to move, that is the fact to notice.
 */
const ADVISORY_JUDGE_DEFINITION_HASH =
  "1517eb5af43c9a7360c099db3a594022e389e850e0883427d287a769db933aaf";

describe("the judge's role comes from the verdict", () => {
  const advisoryRoles: Array<Record<string, unknown>> = [
    { score: 0.2, threshold: 0.8, status: "scored" },
    { score: 0.2, threshold: 0.8, status: "scored", role: "advisory" },
    // Wrong case. A near-miss must never be read as licence to gate.
    { score: 0.2, threshold: 0.8, status: "scored", role: "GATING" },
  ];

  test("absent, advisory and an unrecognised role are byte-identical", () => {
    const built = advisoryRoles.map((judgeVerdict) =>
      buildHostedScoreContract({ predicateResults, evaluation, judgeVerdict })
    );
    for (const contract of built.slice(1)) {
      expect(contract.evaluationConfig).toEqual(built[0].evaluationConfig);
      expect(contract.scores).toEqual(built[0].scores);
    }
    const definition = built[0].evaluationConfig.definitions.find(
      (d) => d.scorerId === HOSTED_JUDGE_SCORER_ID
    );
    expect(definition?.role).toBe("advisory");
    expect(definition?.onError).toBe("ignore");
    expect(definition?.onSkipped).toBe("ignore");
    expect(definition?.label).toBe("goal completion (advisory)");
    // GOLDEN. This digest is stamped on every hosted iteration ever recorded;
    // a change here re-fingerprints all of them and orphans their stored rows
    // from their stored definitions. If this fails, the projection changed —
    // decide whether that was intended before updating the literal.
    expect(built[0].scores.find((s) => s.scorerId === HOSTED_JUDGE_SCORER_ID)
      ?.definitionHash).toBe(ADVISORY_JUDGE_DEFINITION_HASH);
  });

  test("role gating produces a gating definition, same implementation", () => {
    const advisory = buildHostedScoreContract({
      predicateResults,
      evaluation,
      judgeVerdict: { score: 0.2, threshold: 0.8, status: "scored" },
    });
    const gating = buildHostedScoreContract({
      predicateResults,
      evaluation,
      judgeVerdict: {
        score: 0.2,
        threshold: 0.8,
        status: "scored",
        role: "gating",
      },
    });
    const advisoryDef = advisory.evaluationConfig.definitions.find(
      (d) => d.scorerId === HOSTED_JUDGE_SCORER_ID
    );
    const gatingDef = gating.evaluationConfig.definitions.find(
      (d) => d.scorerId === HOSTED_JUDGE_SCORER_ID
    );
    expect(gatingDef?.role).toBe("gating");
    expect(gatingDef?.label).toBe("goal completion (gating)");
    // `resolveScoreDefinition` supplies these from the role, so the backend
    // finalizer reads exactly the rule the contract states rather than a
    // second copy of it in this repo.
    expect(gatingDef?.onError).toBe("fail");
    expect(gatingDef?.onSkipped).toBe("fail");
    // The IMPLEMENTATION did not change — same judge, same template, same
    // arithmetic — so its hash must not move. The role is already an input to
    // `definitionHash`, which is what makes the two definitions distinct
    // without re-fingerprinting the advisory one.
    expect(gatingDef?.implementationHash).toBe(advisoryDef?.implementationHash);
    expect(
      gating.scores.find((s) => s.scorerId === HOSTED_JUDGE_SCORER_ID)
        ?.definitionHash
    ).not.toBe(
      advisory.scores.find((s) => s.scorerId === HOSTED_JUDGE_SCORER_ID)
        ?.definitionHash
    );
  });

  test("a gating judge below threshold fails the shadow verdict", () => {
    const advisory = buildHostedScoreContract({
      predicateResults,
      evaluation,
      judgeVerdict: { score: 0.2, threshold: 0.8, status: "scored" },
    });
    expect(
      shadowVerdictFromScores(advisory.scores, advisory.evaluationConfig)
        .passed
    ).toBe(true);

    const gating = buildHostedScoreContract({
      predicateResults,
      evaluation,
      judgeVerdict: {
        score: 0.2,
        threshold: 0.8,
        status: "scored",
        role: "gating",
      },
    });
    const verdict = shadowVerdictFromScores(
      gating.scores,
      gating.evaluationConfig
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.disagreeingScorerIds).toEqual([HOSTED_JUDGE_SCORER_ID]);
  });

  test("a gating judge that ERRORED is unresolved, never a failure", () => {
    const { scores, evaluationConfig } = buildHostedScoreContract({
      predicateResults,
      evaluation,
      judgeVerdict: {
        threshold: 0.8,
        status: "error",
        error: "judge timeout",
        role: "gating",
      },
    });
    const judgeRow = scores.find((s) => s.scorerId === HOSTED_JUDGE_SCORER_ID);
    // Structurally incapable of failing a trial on its own: no `passed` to
    // fail with. The backend quarantines the trial instead of grading it.
    expect(judgeRow?.passed).toBeUndefined();
    // Read through the contract helper rather than `shadowVerdictFromScores`,
    // which reports only disagreements — the distinction between "disagreed"
    // and "could not answer" is exactly what this test is about.
    const derived = allGatingScorersPassed(scores, evaluationConfig);
    expect(derived.unresolvedScorerIds).toEqual([HOSTED_JUDGE_SCORER_ID]);
    expect(derived.disagreeingScorerIds).toEqual([]);
    // `onError: "fail"` on a gating definition is what makes the gate
    // unsatisfied: a gate nobody could evaluate has not been met.
    expect(derived.passed).toBe(false);
  });
});

describe("shadowVerdictFromScores", () => {
  test("an ADVISORY judge row never participates", () => {
    const { scores, evaluationConfig } = buildHostedScoreContract({
      predicateResults,
      evaluation,
      judgeVerdict: { score: 0, threshold: 0.8, status: "scored" },
    });
    const judgeRow = scores.find((s) => s.scorerId === HOSTED_JUDGE_SCORER_ID);
    expect(judgeRow?.passed).toBe(false);
    expect(shadowVerdictFromScores(scores, evaluationConfig).passed).toBe(true);
  });

  test("an out-of-range judge score errors rather than clamping", () => {
    const { scores } = buildHostedScoreContract({
      evaluation,
      judgeVerdict: { score: 1.4, threshold: 0.8, status: "scored" },
    });
    const judgeRow = scores.find((s) => s.scorerId === HOSTED_JUDGE_SCORER_ID);
    expect(judgeRow?.status).toBe("error");
    expect(judgeRow?.value).toBeUndefined();
    expect(judgeRow?.passed).toBeUndefined();
  });

  // B4 validity distinguishes "this scorer was never measured" from "this
  // iteration had no such scorer": only a projected row can carry that.
  test("a judge that errored is projected as error, not dropped", () => {
    const { scores } = buildHostedScoreContract({
      evaluation,
      judgeVerdict: { threshold: 0.8, status: "error", error: "judge timeout" },
    });
    const judgeRow = scores.find((s) => s.scorerId === HOSTED_JUDGE_SCORER_ID);
    expect(judgeRow?.status).toBe("error");
    expect(judgeRow?.error).toContain("judge timeout");
    expect(judgeRow?.value).toBeUndefined();
  });

  test("a judge that did not run is projected as skipped", () => {
    const { scores, evaluationConfig } = buildHostedScoreContract({
      predicateResults,
      evaluation,
      judgeVerdict: { threshold: 0.8, status: "skipped" },
    });
    const judgeRow = scores.find((s) => s.scorerId === HOSTED_JUDGE_SCORER_ID);
    expect(judgeRow?.status).toBe("skipped");
    // Absent evidence from an ADVISORY scorer still decides nothing.
    expect(shadowVerdictFromScores(scores, evaluationConfig).passed).toBe(true);
  });

  test("an out-of-scope judge is projected as not_applicable", () => {
    const { scores } = buildHostedScoreContract({
      evaluation,
      judgeVerdict: { threshold: 0.8, status: "not_applicable" },
    });
    const judgeRow = scores.find((s) => s.scorerId === HOSTED_JUDGE_SCORER_ID);
    expect(judgeRow?.status).toBe("not_applicable");
  });

  // A malformed verdict is not an absent scorer: it errored.
  test("a scored verdict carrying no number errors rather than vanishing", () => {
    const { scores } = buildHostedScoreContract({
      evaluation,
      judgeVerdict: { threshold: 0.8, status: "scored" },
    });
    const judgeRow = scores.find((s) => s.scorerId === HOSTED_JUDGE_SCORER_ID);
    expect(judgeRow?.status).toBe("error");
  });

  test("an unknown judge status errors even when it carries a numeric score", () => {
    const { scores } = buildHostedScoreContract({
      evaluation,
      judgeVerdict: { score: 1, threshold: 0.8, status: "mystery" },
    });
    const judgeRow = scores.find((s) => s.scorerId === HOSTED_JUDGE_SCORER_ID);
    expect(judgeRow?.status).toBe("error");
    expect(judgeRow?.value).toBeUndefined();
  });

  // Without a threshold there is no definition, so nothing is fabricated.
  test("a thresholdless judge verdict contributes no scorer at all", () => {
    const { scores, evaluationConfig } = buildHostedScoreContract({
      evaluation,
      judgeVerdict: { status: "error" },
    });
    expect(
      scores.some((s) => s.scorerId === HOSTED_JUDGE_SCORER_ID)
    ).toBe(false);
    expect(
      evaluationConfig.definitions.some(
        (d) => d.scorerId === HOSTED_JUDGE_SCORER_ID
      )
    ).toBe(false);
  });

  test("a failing gating row names itself", () => {
    const { scores, evaluationConfig } = buildHostedScoreContract({
      predicateResults: [{ predicate, passed: false }],
      evaluation,
    });
    const verdict = shadowVerdictFromScores(scores, evaluationConfig);
    expect(verdict.passed).toBe(false);
    expect(verdict.disagreeingScorerIds).toHaveLength(1);
    expect(verdict.disagreeingScorerIds[0]).toMatch(/^predicate:/);
  });
});
