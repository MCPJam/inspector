import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { allGatingScorersPassed, definitionHash } from "@mcpjam/sdk/contract";
import { buildHostedScoreContract } from "../score-rows.js";
import {
  HOSTED_RUBRIC_CHECKS_MODEL,
  hostedRubricCheckScoreDefinition,
} from "../score-definitions.js";
import {
  runJudgeSecondPass,
  type JudgeSecondPassPorts,
} from "../judge-second-pass.js";
import type { JudgeSecondPassRunRow } from "../judge-stage-backend.js";

// =============================================================================
// Rubric checks: the backend stamps `metadata.rubricChecksVerdict` from the
// goal-completion job, and the judge second pass projects it into ADVISORY
// score rows beside the goal judge's own. What these cases pin:
//
//   - a definition names Jev and never the rail that answered, so a fallback
//     on one trial does not fork a criterion's identity;
//   - rewording a question (its content digest) is a new definition, a new
//     label alone is not;
//   - no answer is an error row, a pass that never ran is a skipped row, and a
//     malformed question is dropped rather than invented;
//   - none of it can move a gate.
// =============================================================================

const verdict = {
  status: "scored",
  templateVersion: 1,
  templateHash: "tpl-1",
  model: HOSTED_RUBRIC_CHECKS_MODEL,
  decidedBy: "jev",
  goalCompletionJobId: "job1",
  questions: [
    {
      key: "c:cites",
      kind: "boolean",
      label: "Cites a source",
      contentDigest: "d-cites",
      passThreshold: 0.5,
      status: "scored",
      value: 0.93,
      passed: true,
      rationale: "P(yes) 0.93",
      evidence: ["decided by Jev"],
    },
    {
      key: "c:polite",
      kind: "boolean",
      label: "Stays polite",
      contentDigest: "d-polite",
      passThreshold: 0.5,
      status: "error",
      error: "no_answer",
      rationale: "",
      evidence: [],
    },
    {
      key: "q:tone",
      kind: "choice",
      label: "Tone",
      contentDigest: "d-tone",
      passThreshold: 1,
      status: "scored",
      value: 0,
      passed: false,
      rationale: "chose curt",
      evidence: [],
    },
  ],
};

function contract(rubricChecksVerdict: Record<string, unknown>) {
  return buildHostedScoreContract({ rubricChecksVerdict });
}

describe("rubric-check definitions", () => {
  test("name Jev, are advisory, and key the scorer by question", () => {
    const { evaluationConfig } = contract(verdict);
    const ids = evaluationConfig.definitions.map((d) => d.scorerId);
    expect(ids).toEqual([
      "judge:rubricChecks:c:cites",
      "judge:rubricChecks:c:polite",
      "judge:rubricChecks:q:tone",
    ]);
    for (const definition of evaluationConfig.definitions) {
      expect(definition.role).toBe("advisory");
      expect(definition.model).toBe(HOSTED_RUBRIC_CHECKS_MODEL);
      expect(definition.deterministic).toBe(false);
    }
    expect(evaluationConfig.definitions[2]!.passThreshold).toBe(1);
  });

  test("a reworded question is a new definition; a relabel alone is not", () => {
    const base = {
      key: "c:cites",
      kind: "boolean" as const,
      label: "Cites a source",
      contentDigest: "d-cites",
      passThreshold: 0.5,
      templateVersion: 1,
      templateHash: "tpl-1",
    };
    const hash = (over: Partial<typeof base>) =>
      definitionHash({
        ...hostedRubricCheckScoreDefinition({ ...base, ...over }),
        onError: "ignore",
        onSkipped: "ignore",
      });
    expect(hash({ label: "Cites its source" })).toBe(hash({}));
    expect(hash({ contentDigest: "d-cites-v2" })).not.toBe(hash({}));
    expect(hash({ templateVersion: 2 })).not.toBe(hash({}));
  });
});

describe("rubric-check rows", () => {
  test("carry the answering rail on the row, not in the definition", () => {
    const jev = contract(verdict);
    const fallback = contract({
      ...verdict,
      model: "openai/gpt-5.6-luna",
      decidedBy: "llm",
    });
    const cites = (rows: typeof jev.scores) =>
      rows.find((row) => row.scorerId === "judge:rubricChecks:c:cites")!;
    expect(cites(jev.scores)).toMatchObject({
      status: "scored",
      value: 0.93,
      passed: true,
      model: HOSTED_RUBRIC_CHECKS_MODEL,
    });
    expect(cites(fallback.scores).model).toBe("openai/gpt-5.6-luna");
    // Same identity whichever rail answered.
    expect(cites(fallback.scores).definitionHash).toBe(
      cites(jev.scores).definitionHash,
    );
    expect(fallback.evaluationConfig.hash).toBe(jev.evaluationConfig.hash);
  });

  test("an unanswered question is an error row, never a zero", () => {
    const polite = contract(verdict).scores.find(
      (row) => row.scorerId === "judge:rubricChecks:c:polite",
    )!;
    expect(polite.status).toBe("error");
    expect(polite.value).toBeUndefined();
    expect(polite.error).toBe("no_answer");
  });

  test("a pass that never ran is skipped, with its reason", () => {
    const { scores } = contract({
      ...verdict,
      status: "skipped",
      reason: "rails_unavailable",
      questions: verdict.questions.map((q) => ({
        ...q,
        status: "skipped",
        value: undefined,
        passed: undefined,
      })),
    });
    expect(scores.map((row) => row.status)).toEqual([
      "skipped",
      "skipped",
      "skipped",
    ]);
    expect(scores[0]!.rationale).toContain("rails_unavailable");
  });

  test("drops a malformed question instead of inventing a scorer", () => {
    const { scores, evaluationConfig } = contract({
      ...verdict,
      questions: [
        ...verdict.questions,
        { key: "c:no-digest", kind: "boolean", passThreshold: 0.5 },
        {
          key: "x:bad",
          kind: "boolean",
          contentDigest: "d",
          passThreshold: 0.5,
        },
        { ...verdict.questions[0], label: "duplicate key" },
      ],
    });
    expect(evaluationConfig.definitions).toHaveLength(3);
    expect(scores).toHaveLength(3);
  });

  test("never enters the gate, whatever they say", () => {
    const { scores, evaluationConfig } = contract(verdict);
    expect(allGatingScorersPassed(scores, evaluationConfig).passed).toBe(true);
  });
});

describe("the judge second pass forwards the verdict on the goal channel", () => {
  const ENV_KEY = "MCPJAM_GRADING_ENGINE_MODE";
  const originalEnv = process.env[ENV_KEY];
  beforeEach(() => {
    process.env[ENV_KEY] = "dual_write";
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = originalEnv;
  });

  function run(metadata: Record<string, unknown>): JudgeSecondPassRunRow {
    return {
      runId: "run1",
      goalCompletionJobId: "job1",
      configSnapshot: { gradingEngine: { mode: "dual_write" } },
      iterations: [
        {
          iterationId: "iter1",
          status: "completed",
          authoredCase: { expectedToolCalls: [], expectedOutput: "done" },
          messages: [{ role: "user", content: "hi" }],
          metadata: {
            judgeVerdict: {
              status: "scored",
              verdict: "pass",
              score: 0.9,
              threshold: 0.7,
            },
            ...metadata,
          },
        },
      ],
    } as JudgeSecondPassRunRow;
  }

  function ports(row: JudgeSecondPassRunRow) {
    const applied: Array<Record<string, unknown>> = [];
    const value: JudgeSecondPassPorts = {
      fetchRun: vi.fn(async () => row),
      applyDerivation: vi.fn(async (_id: string, body) => {
        applied.push(body as Record<string, unknown>);
        return { outcome: "applied" as const };
      }),
      markFanout: vi.fn(async () => ({ outcome: "completed" })),
      applyMetadataAttributionDerivation: vi.fn(async () => ({
        outcome: "applied" as const,
      })),
      markMetadataAttributionFanout: vi.fn(async () => ({
        outcome: "completed",
      })),
    } as unknown as JudgeSecondPassPorts;
    return { value, applied };
  }

  test("posts rubric rows and their definitions beside the judge's", async () => {
    const { value, applied } = ports(run({ rubricChecksVerdict: verdict }));
    await runJudgeSecondPass("run1", value);
    const body = applied[0]!;
    const scorerIds = (body.scores as Array<{ scorerId: string }>).map(
      (row) => row.scorerId,
    );
    expect(scorerIds).toContain("judge:goalCompletion");
    expect(scorerIds).toContain("judge:rubricChecks:c:cites");
    const definitions = (
      body.evaluationConfig as { definitions: Array<{ scorerId: string }> }
    ).definitions.map((d) => d.scorerId);
    expect(definitions).toContain("judge:rubricChecks:q:tone");
  });

  test("posts exactly what it did before when there is no verdict", async () => {
    const without = ports(run({}));
    await runJudgeSecondPass("run1", without.value);
    const scorerIds = (
      without.applied[0]!.scores as Array<{ scorerId: string }>
    ).map((row) => row.scorerId);
    expect(scorerIds.some((id) => id.startsWith("judge:rubricChecks:"))).toBe(
      false,
    );
  });
});
