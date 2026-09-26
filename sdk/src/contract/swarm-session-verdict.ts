/**
 * Swarm goal grading, independent of execution and advisory observations.
 * Pure, browser-safe contract. Backend consumers mirror this module and its
 * parity fixtures; rendering surfaces consume its result without re-grading.
 */
import { z } from "zod";
import type { IterationStatus } from "./chain.js";

export const SWARM_SESSION_VERDICT_CONTRACT_VERSION = 1;
/** Swarm stage evidence semantics; old stamps must not count as current. */
export const SWARM_STAGE_EVIDENCE_VERSION = 2;
export const SWARM_ATTEMPT_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "rate_limited",
] as const;
export const SWARM_SESSION_LIFECYCLES = [
  "pending",
  "running",
  "ran",
  "broke",
  "limited",
  "withdrawn",
] as const;
export const SWARM_SESSION_VERDICTS = [
  "passed",
  "failed",
  "inconclusive",
  "notEstablished",
] as const;
export const SWARM_GRADING_STATES = [
  "notRequested",
  "queued",
  "running",
  "settled",
  "unavailable",
] as const;
export const SWARM_WITHDRAWN_ERROR_CODES = [
  "canceled",
  "stale_runner",
  "runner_shutdown",
  "run_timeout",
] as const;
export const SWARM_SESSION_VERDICT_OF_REASON = {
  attemptPending: "notEstablished",
  attemptRunning: "notEstablished",
  withdrawn: "notEstablished",
  spendCapReached: "notEstablished",
  notRun: "notEstablished",
  executionFailed: "notEstablished",
  ungraded: "notEstablished",
  gradingNotClaimed: "notEstablished",
  criteriaPending: "notEstablished",
  judgePending: "notEstablished",
  gatingCriterionFailed: "failed",
  judgeFailed: "failed",
  criteriaGradingErrored: "inconclusive",
  gatingCriterionUnmeasured: "inconclusive",
  judgeErrored: "inconclusive",
  gradingUnavailable: "inconclusive",
  allGatingCriteriaPassed: "passed",
  judgePassed: "passed",
  allGradersPassed: "passed",
} as const satisfies Record<string, (typeof SWARM_SESSION_VERDICTS)[number]>;
export type SwarmSessionVerdictReason =
  keyof typeof SWARM_SESSION_VERDICT_OF_REASON;
export const SWARM_SESSION_VERDICT_REASONS = Object.keys(
  SWARM_SESSION_VERDICT_OF_REASON
) as [SwarmSessionVerdictReason, ...SwarmSessionVerdictReason[]];
export const swarmSessionLifecycleSchema = z.enum(SWARM_SESSION_LIFECYCLES);
export const swarmSessionVerdictValueSchema = z.enum(SWARM_SESSION_VERDICTS);
export const swarmGraderRoleSchema = z.enum(["advisory", "required"]);
export const swarmSessionAttemptInputSchema = z
  .object({
    status: z.enum(SWARM_ATTEMPT_STATUSES),
    errorCode: z.string().nullable().optional(),
  })
  .strict();
export const swarmGradingReadinessSchema = z
  .object({
    /** Durable readiness for decisive grading only, not background observations. */
    state: z.enum(SWARM_GRADING_STATES),
    reasonCode: z.string().min(1).optional(),
  })
  .strict();
const criterionResultSchema = z
  .object({
    criterionId: z.string().min(1),
    passed: z.boolean(),
    status: z.enum(["scored", "error"]).optional(),
  })
  .strict();
export const swarmSessionVerdictInputSchema = z
  .object({
    attempt: swarmSessionAttemptInputSchema.nullable(),
    hasTranscript: z.boolean(),
    rubric: z.array(
      z
        .object({
          id: z.string().min(1),
          role: swarmGraderRoleSchema,
          predicateType: z.string().min(1).optional(),
        })
        .strict()
    ),
    criteria: z
      .object({
        status: z.enum(["pending", "completed", "failed"]),
        criterionIds: z.array(z.string().min(1)).optional(),
        results: z.array(criterionResultSchema).optional(),
      })
      .strict()
      .nullable(),
    goalScore: z
      .discriminatedUnion("status", [
        z
          .object({ status: z.literal("completed"), passed: z.boolean() })
          .strict(),
        z.object({ status: z.literal("running") }).strict(),
        z.object({ status: z.literal("failed") }).strict(),
      ])
      .nullable(),
    judge: z
      .object({
        automatic: z.boolean(),
        role: swarmGraderRoleSchema,
        /** Explicit on-demand intent; automatic:false alone does not mean a judge was requested. */
        requested: z.boolean().optional(),
      })
      .strict(),
    grading: swarmGradingReadinessSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const definitions = new Set(value.rubric.map((entry) => entry.id));
    if (definitions.size !== value.rubric.length) {
      ctx.addIssue({
        code: "custom",
        path: ["rubric"],
        message: "Duplicate criterion definition",
      });
    }
    for (const [field, ids] of [
      ["criterionIds", value.criteria?.criterionIds ?? []],
      ["results", value.criteria?.results?.map((row) => row.criterionId) ?? []],
    ] as const) {
      if (
        new Set(ids).size !== ids.length ||
        ids.some((id) => !definitions.has(id))
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["criteria", field],
          message: "Criterion IDs must be unique and defined in the snapshot",
        });
      }
    }
    const claimed = value.criteria?.criterionIds;
    if (
      claimed &&
      value.criteria?.results?.some((row) => !claimed.includes(row.criterionId))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["criteria", "results"],
        message: "Result outside claimed scope",
      });
    }
  });
export type SwarmSessionVerdictInput = z.infer<
  typeof swarmSessionVerdictInputSchema
>;
export type SwarmSessionAttemptInput = z.infer<
  typeof swarmSessionAttemptInputSchema
>;
export type SwarmSessionLifecycle = z.infer<typeof swarmSessionLifecycleSchema>;
export type SwarmSessionVerdictValue = z.infer<
  typeof swarmSessionVerdictValueSchema
>;

/** No invented skipped/completed lifecycle. Null defers aggregation while a grade is pending or unrequested. */
export const SWARM_SESSION_TRIAL_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "setup_failed",
  "cancelled",
] as const satisfies readonly IterationStatus[];
export const swarmSessionTrialSchema = z
  .object({
    status: z.enum(SWARM_SESSION_TRIAL_STATUSES),
    taskVerdict: z.enum(["passed", "failed"]).optional(),
    evaluatorError: z.literal(true).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const verdict = value.taskVerdict !== undefined;
    const error = value.evaluatorError === true;
    if (value.status === "completed" ? verdict === error : verdict || error) {
      ctx.addIssue({
        code: "custom",
        message:
          "Only completed trials carry exactly one verdict or evaluator error",
      });
    }
  });
export type SwarmSessionTrial = z.infer<typeof swarmSessionTrialSchema>;
export const swarmSessionGraderCountsSchema = z
  .object({
    gating: z.number().int().nonnegative(),
    gatingPassed: z.number().int().nonnegative(),
    gatingFailed: z.number().int().nonnegative(),
    gatingUnmeasured: z.number().int().nonnegative(),
    advisoryFailed: z.number().int().nonnegative(),
  })
  .strict();
export const swarmSessionVerdictSchema = z
  .object({
    contractVersion: z.literal(SWARM_SESSION_VERDICT_CONTRACT_VERSION),
    lifecycle: swarmSessionLifecycleSchema,
    verdict: swarmSessionVerdictValueSchema,
    reason: z.enum(SWARM_SESSION_VERDICT_REASONS),
    verdictSource: z.enum([
      "goalJudge",
      "requiredAssertions",
      "combined",
      "none",
    ]),
    grading: swarmGradingReadinessSchema,
    graders: z
      .object({
        criteria: z.enum([
          "notConfigured",
          "notClaimed",
          "pending",
          "scored",
          "errored",
        ]),
        judge: z.enum([
          "notConfigured",
          "silent",
          "pending",
          "scored",
          "errored",
        ]),
      })
      .strict(),
    counts: swarmSessionGraderCountsSchema,
    trial: swarmSessionTrialSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    if (SWARM_SESSION_VERDICT_OF_REASON[value.reason] !== value.verdict)
      fail("Reason contradicts verdict");
    const c = value.counts;
    if (c.gating !== c.gatingPassed + c.gatingFailed + c.gatingUnmeasured)
      fail("Required measurement counts do not add up");
    const trial = value.trial;
    if (trial?.status === "completed") {
      if (value.lifecycle !== "ran")
        fail("Only a completed execution can be a completed trial");
      if (
        trial.taskVerdict !== undefined &&
        trial.taskVerdict !== value.verdict
      )
        fail("Trial contradicts goal result");
      if (trial.evaluatorError && value.verdict !== "inconclusive")
        fail("Evaluator error requires inconclusive grading");
    }
    const expected = {
      pending: "pending",
      running: "running",
      broke: "failed",
      limited: "setup_failed",
      withdrawn: "cancelled",
    } as const;
    if (
      value.lifecycle !== "ran" &&
      trial?.status !== expected[value.lifecycle]
    )
      fail("Trial must preserve execution lifecycle");
    if (
      value.lifecycle === "ran" &&
      trial !== null &&
      trial.status !== "completed"
    )
      fail("Completed execution must not become skipped or running");
    if (
      (value.verdict === "passed" || value.verdict === "failed") &&
      value.verdictSource === "none"
    )
      fail("A measured goal verdict needs a source");
    if (
      value.lifecycle === "ran" &&
      value.verdict !== "notEstablished" &&
      trial === null
    )
      fail("Settled grading on completed execution needs an observation");
    if (value.verdict === "notEstablished" && value.verdictSource !== "none")
      fail("An undecided goal has no verdict source");
  });
export type SwarmSessionVerdict = z.infer<typeof swarmSessionVerdictSchema>;

export function swarmAttemptLifecycle(
  attempt: SwarmSessionAttemptInput | null,
  hasTranscript = false
): SwarmSessionLifecycle {
  if (!attempt || attempt.status === "pending") return "pending";
  if (attempt.status === "running") return "running";
  if (
    (
      SWARM_WITHDRAWN_ERROR_CODES as readonly (string | null | undefined)[]
    ).includes(attempt.errorCode)
  )
    return "withdrawn";
  if (attempt.status === "rate_limited" && !hasTranscript) return "limited";
  return attempt.status === "succeeded" ? "ran" : "broke";
}

/**
 * A session whose attempt ENDED without recording a single message never ran.
 * Nothing about the server under test was exercised, so the refusal is the
 * only true thing any surface can say about it (MCPJam/inspector#5188).
 * Published findings count a session as started on the same
 * `messageCount > 0`, so every reader agrees on which sessions ran.
 */
export function swarmSessionNeverRan(
  lifecycle: SwarmSessionLifecycle,
  messageCount: number
): boolean {
  return (
    (lifecycle === "broke" ||
      lifecycle === "limited" ||
      lifecycle === "withdrawn") &&
    messageCount === 0
  );
}

/** Shared with the stage adapter: advisory observations do not displace the goal judge. */
export function swarmJudgeIsDecisive(
  input: Pick<SwarmSessionVerdictInput, "rubric" | "judge">
): boolean {
  return (
    input.judge.role === "required" ||
    !input.rubric.some((entry) => entry.role === "required")
  );
}

export function deriveSwarmSessionVerdict(
  raw: SwarmSessionVerdictInput
): SwarmSessionVerdict {
  const input = swarmSessionVerdictInputSchema.parse(raw);
  const lifecycle = swarmAttemptLifecycle(input.attempt, input.hasTranscript);
  const required = input.rubric.filter((entry) => entry.role === "required");
  const results = new Map(
    input.criteria?.status === "completed"
      ? input.criteria.results?.map((row) => [row.criterionId, row])
      : []
  );
  const counts = {
    gating: required.length,
    gatingPassed: 0,
    gatingFailed: 0,
    gatingUnmeasured: 0,
    advisoryFailed: 0,
  };
  for (const entry of input.rubric) {
    const row = results.get(entry.id);
    if (entry.role === "advisory") {
      if (row?.status !== "error" && row?.passed === false)
        counts.advisoryFailed++;
    } else if (!row || row.status === "error") counts.gatingUnmeasured++;
    else if (row.passed) counts.gatingPassed++;
    else counts.gatingFailed++;
  }
  const decisive = swarmJudgeIsDecisive(input);
  const score = input.goalScore;
  const waiting =
    input.grading.state === "queued" || input.grading.state === "running";
  const judgeOwed =
    decisive &&
    (input.judge.automatic || input.judge.requested === true || score !== null);
  const criteriaReadiness = (): SwarmSessionVerdict["graders"]["criteria"] => {
    if (!input.rubric.length) return "notConfigured";
    if (!input.criteria) return "notClaimed";
    if (input.criteria.status === "pending") return "pending";
    if (input.criteria.status === "failed") return "errored";
    const missing = input.rubric.some(
      (entry) =>
        (entry.role === "required" ||
          !input.criteria?.criterionIds ||
          input.criteria.criterionIds.includes(entry.id)) &&
        (!results.has(entry.id) || results.get(entry.id)?.status === "error")
    );
    return missing ? "errored" : "scored";
  };
  const judgeReadiness = (): SwarmSessionVerdict["graders"]["judge"] => {
    if (!decisive) return "silent";
    if (score?.status === "completed") return "scored";
    if (score?.status === "failed") return "errored";
    if (score?.status === "running" || (judgeOwed && waiting)) return "pending";
    if (judgeOwed && input.grading.state === "unavailable") return "errored";
    return "notConfigured";
  };
  const graders = { criteria: criteriaReadiness(), judge: judgeReadiness() };
  const finish = (
    reason: SwarmSessionVerdictReason,
    source: SwarmSessionVerdict["verdictSource"] = "none"
  ): SwarmSessionVerdict => {
    const verdict = SWARM_SESSION_VERDICT_OF_REASON[reason];
    let trial: SwarmSessionTrial | null;
    switch (lifecycle) {
      case "pending":
        trial = { status: "pending" };
        break;
      case "running":
        trial = { status: "running" };
        break;
      case "withdrawn":
        trial = { status: "cancelled" };
        break;
      case "limited":
        trial = { status: "setup_failed" };
        break;
      case "broke":
        trial = { status: "failed" };
        break;
      case "ran":
        if (verdict === "passed" || verdict === "failed")
          trial = { status: "completed", taskVerdict: verdict };
        else if (verdict === "inconclusive")
          trial = { status: "completed", evaluatorError: true };
        else trial = null;
    }
    return swarmSessionVerdictSchema.parse({
      contractVersion: SWARM_SESSION_VERDICT_CONTRACT_VERSION,
      lifecycle,
      verdict,
      reason,
      verdictSource: source,
      grading: input.grading,
      graders,
      counts,
      trial,
    });
  };
  if (lifecycle === "pending") return finish("attemptPending");
  if (lifecycle === "running") return finish("attemptRunning");
  if (lifecycle === "withdrawn") return finish("withdrawn");
  if (lifecycle === "limited")
    return finish(
      input.attempt?.errorCode === "spend_cap_exceeded"
        ? "spendCapReached"
        : "notRun"
    );
  // Proven failures outrank missing/pending evidence, but never alter execution.
  if (counts.gatingFailed > 0)
    return finish("gatingCriterionFailed", "requiredAssertions");
  if (decisive && score?.status === "completed" && !score.passed)
    return finish("judgeFailed", "goalJudge");
  if (!input.hasTranscript)
    return finish(
      lifecycle === "ran" ? "gradingUnavailable" : "executionFailed"
    );
  if (required.length > 0 && input.criteria?.status === "failed")
    return finish("criteriaGradingErrored");
  if (
    required.length > 0 &&
    input.criteria?.status === "completed" &&
    counts.gatingUnmeasured > 0
  )
    return finish("gatingCriterionUnmeasured");
  if (decisive && score?.status === "failed") return finish("judgeErrored");
  if (
    input.grading.state === "unavailable" &&
    (counts.gatingUnmeasured > 0 ||
      (judgeOwed && score?.status !== "completed"))
  )
    return finish("gradingUnavailable");
  if (counts.gatingUnmeasured > 0) {
    if (input.grading.state === "settled")
      return finish("gatingCriterionUnmeasured");
    return finish(input.criteria ? "criteriaPending" : "gradingNotClaimed");
  }
  if (judgeOwed && score?.status !== "completed") {
    if (input.grading.state === "settled") return finish("gradingUnavailable");
    return finish(
      waiting || score?.status === "running"
        ? "judgePending"
        : "gradingNotClaimed"
    );
  }
  // A caller can still hold the old scored row while a new generation queues.
  // Durable decisive readiness prevents that old pass becoming current again.
  if (waiting)
    return finish(decisive && judgeOwed ? "judgePending" : "criteriaPending");
  if (decisive && score?.status === "completed")
    return finish(
      required.length ? "allGradersPassed" : "judgePassed",
      required.length ? "combined" : "goalJudge"
    );
  if (required.length > 0)
    return finish("allGatingCriteriaPassed", "requiredAssertions");
  return finish("ungraded");
}

/** Shared human labels for UI and CLI. Missing historical evidence is unknown. */
export function swarmVerdictLabel(verdict?: SwarmSessionVerdict): string {
  if (!verdict) return "Unknown";
  if (verdict.verdict === "notEstablished") {
    if (["queued", "running"].includes(verdict.grading.state)) return "Grading";
    if (verdict.reason === "ungraded") return "Not graded";
    return "Not established";
  }
  return swarmVerdictValueLabel(verdict.verdict);
}
export function swarmVerdictValueLabel(
  value: SwarmSessionVerdictValue
): string {
  return {
    passed: "Passed",
    failed: "Failed",
    inconclusive: "Inconclusive",
    notEstablished: "Not established",
  }[value];
}
export function swarmLifecycleLabel(value: SwarmSessionLifecycle): string {
  return {
    pending: "Pending",
    running: "Running",
    ran: "Ran",
    broke: "Broke",
    limited: "Limited",
    withdrawn: "Withdrawn",
  }[value];
}
