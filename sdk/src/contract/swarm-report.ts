/** One reporting projection for swarm UI/API/MCP/CLI. Never decides a run from session counts. */
import { z } from "zod";
import { evalVerdictDecisionSchema } from "./verdict-policy.js";
import { USER_VALUE_STAGES } from "./chain.js";
import { ASSERTION_STAGE, type AssertionKind } from "./evaluator-stage.js";
import {
  swarmSessionVerdictSchema,
  swarmSessionVerdictValueSchema,
  type SwarmSessionVerdictValue,
} from "./swarm-session-verdict.js";

export const SWARM_REPORT_CONTRACT_VERSION = 1;
const count = z.number().int().nonnegative();
export const journeyRunVerdictSummarySchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("pending"),
      pendingSessions: count,
      updatedAt: count,
    })
    .strict(),
  z
    .object({
      status: z.literal("decided"),
      decision: evalVerdictDecisionSchema,
      updatedAt: count,
    })
    .strict(),
  z
    .object({
      status: z.literal("notEstablished"),
      reason: z.literal("gradingNotConfigured"),
      updatedAt: count,
    })
    .strict(),
  z
    .object({
      status: z.literal("integrityFailed"),
      reason: z.string().min(1),
      updatedAt: count,
    })
    .strict(),
]);
export type JourneyRunVerdictSummary = z.infer<
  typeof journeyRunVerdictSummarySchema
>;
export const swarmObservationInputSchema = z
  .object({
    evaluatorId: z.string().min(1),
    predicateType: z.enum(
      Object.keys(ASSERTION_STAGE) as [AssertionKind, ...AssertionKind[]]
    ),
    role: z.enum(["advisory", "required"]),
    /** Missing capture/error is unavailable; it must not use the compatibility passed:false. */
    status: z.enum(["passed", "failed", "pending", "unavailable"]),
  })
  .strict();
export const swarmReportSessionSchema = z
  .object({
    /** Stable attempt/slot identity, including slots with no session document. */
    id: z.string().min(1),
    /** A producer fact. Grade coverage and lifecycle alone cannot establish a non-start. */
    startEvidence: z.enum(["started", "notStarted", "unknown"]),
    verdict: swarmSessionVerdictSchema,
    observations: z.array(swarmObservationInputSchema),
  })
  .strict()
  .superRefine((row, ctx) => {
    if (
      new Set(row.observations.map((o) => o.evaluatorId)).size !==
      row.observations.length
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["observations"],
        message: "Duplicate evaluator in one session",
      });
    }
    if (
      row.startEvidence === "notStarted" &&
      ["running", "ran"].includes(row.verdict.lifecycle)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["startEvidence"],
        message: "Execution contradicts explicit non-start",
      });
    }
  });
export const swarmReportInputSchema = z
  .object({
    runId: z.string().min(1),
    executionComplete: z.boolean(),
    configuredSessions: count,
    verdictSummary: journeyRunVerdictSummarySchema.nullable(),
    /** Frozen run-wide definitions: absent measurement rows still count as unavailable. */
    evaluatorDefinitions: z.array(
      swarmObservationInputSchema.omit({ status: true })
    ),
    sessions: z.array(swarmReportSessionSchema),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.sessions.length > input.configuredSessions) {
      ctx.addIssue({
        code: "custom",
        path: ["sessions"],
        message: "Reported sessions exceed configured population",
      });
    }
    if (
      new Set(input.sessions.map((row) => row.id)).size !==
      input.sessions.length
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["sessions"],
        message: "Duplicate session/attempt identity",
      });
    }
    const definitions = new Map(
      input.evaluatorDefinitions.map((row) => [row.evaluatorId, row])
    );
    if (definitions.size !== input.evaluatorDefinitions.length) {
      ctx.addIssue({
        code: "custom",
        path: ["evaluatorDefinitions"],
        message: "Duplicate evaluator definition",
      });
    }
    for (const session of input.sessions) {
      for (const observation of session.observations) {
        const definition = definitions.get(observation.evaluatorId);
        if (
          !definition ||
          definition.role !== observation.role ||
          definition.predicateType !== observation.predicateType
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["sessions"],
            message: "Observation contradicts the frozen evaluator definition",
          });
        }
      }
    }
  });
export type SwarmReportInput = z.infer<typeof swarmReportInputSchema>;
export const swarmObservationCoverageSchema = z
  .object({
    evaluatorId: z.string().min(1),
    predicateType: z.enum(
      Object.keys(ASSERTION_STAGE) as [AssertionKind, ...AssertionKind[]]
    ),
    role: z.enum(["advisory", "required"]),
    stage: z.enum(USER_VALUE_STAGES).describe(
      "The stage this observation was read from, and the only stage it is " +
        "evidence ABOUT. `connection` — the server was reachable and the " +
        "session initialized. `discovery` — its tools and resources were " +
        "listed and readable. `selection` — the model chose the right tool " +
        "for the request. `call` — the call was made with usable arguments. " +
        "`response` — the server returned data the model could use. " +
        "`userValue` — the user's actual request was satisfied."
    ),
    unit: z.literal("sessions"),
    total: count,
    passed: count,
    failed: count,
    pending: count,
    unavailable: count,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.total !==
      value.passed + value.failed + value.pending + value.unavailable
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Observation coverage must partition its population",
      });
    }
    if (value.stage !== ASSERTION_STAGE[value.predicateType]) {
      ctx.addIssue({
        code: "custom",
        message: "Observation stage contradicts the shared evaluator map",
      });
    }
  });
export const swarmReportSchema = z
  .object({
    contractVersion: z.literal(SWARM_REPORT_CONTRACT_VERSION),
    runId: z.string().min(1),
    verdict: swarmSessionVerdictValueSchema,
    verdictSource: z.enum(["policyV2", "none"]),
    decision: evalVerdictDecisionSchema.optional(),
    undecidedReason: z
      .enum([
        "executionPending",
        "gradingPending",
        "gradingNotConfigured",
        "verdictSummaryUnavailable",
        "integrityFailed",
      ])
      .optional(),
    execution: z
      .object({
        unit: z.literal("sessions"),
        configured: count,
        reported: count,
        started: count,
        notStarted: count,
        unknown: count,
        completed: count,
        interrupted: count,
        /** Only explicit complete execution evidence can establish this. */
        neverLaunched: z.boolean(),
      })
      .strict(),
    goalGrading: z
      .object({
        unit: z.literal("sessions"),
        reported: count,
        passed: count,
        failed: count,
        pending: count,
        unavailable: count,
        notRequested: count,
        /** Readiness is separate: a proven failure can exist while other required grading is pending. */
        waitingForDecisiveGrading: count,
      })
      .strict(),
    observations: z.array(swarmObservationCoverageSchema),
  })
  .strict()
  .superRefine((report, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    if (report.verdictSource === "policyV2") {
      if (
        !report.decision ||
        report.verdict !== report.decision.verdict ||
        report.undecidedReason !== undefined
      )
        fail("Report must copy its authoritative decision");
    } else if (
      report.verdict !== "notEstablished" ||
      report.decision !== undefined ||
      !report.undecidedReason
    )
      fail("Missing authority must have an undecided reason");
    const e = report.execution;
    if (
      e.started + e.notStarted + e.unknown !== e.configured ||
      e.reported > e.configured
    )
      fail("Execution evidence does not cover its configured population");
    if (
      e.started + e.notStarted > e.reported ||
      e.completed + e.interrupted > e.reported
    )
      fail("Execution counts exceed reported evidence");
    if (
      e.neverLaunched !==
      (e.configured > 0 &&
        e.reported === e.configured &&
        e.notStarted === e.configured)
    )
      fail("Not run requires explicit evidence for the entire population");
    const g = report.goalGrading;
    if (
      g.reported !== e.reported ||
      g.passed + g.failed + g.pending + g.unavailable + g.notRequested !==
        g.reported ||
      g.waitingForDecisiveGrading > g.reported
    )
      fail("Goal coverage must partition reported sessions");
    if (
      new Set(report.observations.map((o) => o.evaluatorId)).size !==
        report.observations.length ||
      report.observations.some((o) => o.total > e.reported)
    )
      fail("Invalid observation population");
  });
export type SwarmReport = z.infer<typeof swarmReportSchema>;

export function assembleSwarmReport(raw: SwarmReportInput): SwarmReport {
  const input = swarmReportInputSchema.parse(raw);
  const execution: SwarmReport["execution"] = {
    unit: "sessions",
    configured: input.configuredSessions,
    reported: input.sessions.length,
    started: 0,
    notStarted: 0,
    unknown: input.configuredSessions - input.sessions.length,
    completed: 0,
    interrupted: 0,
    neverLaunched: false,
  };
  const goalGrading: SwarmReport["goalGrading"] = {
    unit: "sessions",
    reported: input.sessions.length,
    passed: 0,
    failed: 0,
    pending: 0,
    unavailable: 0,
    notRequested: 0,
    waitingForDecisiveGrading: 0,
  };
  const observations = new Map<string, SwarmReport["observations"][number]>();
  for (const session of input.sessions) {
    execution[session.startEvidence]++;
    const v = session.verdict;
    if (v.lifecycle === "ran") execution.completed++;
    if (
      session.startEvidence === "started" &&
      (v.lifecycle === "broke" || v.lifecycle === "withdrawn")
    )
      execution.interrupted++;
    const waiting =
      v.grading.state === "queued" || v.grading.state === "running";
    if (waiting) goalGrading.waitingForDecisiveGrading++;
    if (v.verdict === "passed" || v.verdict === "failed")
      goalGrading[v.verdict]++;
    else if (v.verdict === "inconclusive") goalGrading.unavailable++;
    else if (waiting) goalGrading.pending++;
    else if (
      v.reason === "gradingNotClaimed" ||
      v.reason === "criteriaPending" ||
      v.reason === "judgePending"
    )
      goalGrading.unavailable++;
    else goalGrading.notRequested++;
    const recorded = new Map(
      session.observations.map((row) => [row.evaluatorId, row])
    );
    for (const definition of input.evaluatorDefinitions) {
      const observation = recorded.get(definition.evaluatorId) ?? {
        ...definition,
        status: "unavailable" as const,
      };
      const existing = observations.get(observation.evaluatorId);
      const row = existing ?? {
        evaluatorId: observation.evaluatorId,
        predicateType: observation.predicateType,
        role: observation.role,
        stage: ASSERTION_STAGE[observation.predicateType],
        unit: "sessions" as const,
        total: 0,
        passed: 0,
        failed: 0,
        pending: 0,
        unavailable: 0,
      };
      row.total++;
      row[observation.status]++;
      observations.set(row.evaluatorId, row);
    }
  }
  execution.neverLaunched =
    execution.configured > 0 && execution.notStarted === execution.configured;
  const summary = input.verdictSummary;
  let undecidedReason: SwarmReport["undecidedReason"];
  if (!input.executionComplete) undecidedReason = "executionPending";
  else if (
    goalGrading.waitingForDecisiveGrading > 0 ||
    summary?.status === "pending"
  )
    undecidedReason = "gradingPending";
  else if (!summary) undecidedReason = "verdictSummaryUnavailable";
  else if (summary.status === "integrityFailed")
    undecidedReason = "integrityFailed";
  else if (summary.status === "notEstablished")
    undecidedReason = "gradingNotConfigured";
  const decided = !undecidedReason && summary?.status === "decided";
  const decisionFields = decided
    ? {
        verdict: summary.decision.verdict,
        verdictSource: "policyV2",
        decision: summary.decision,
      }
    : {
        verdict: "notEstablished",
        verdictSource: "none",
        undecidedReason: undecidedReason ?? "verdictSummaryUnavailable",
      };
  return swarmReportSchema.parse({
    contractVersion: SWARM_REPORT_CONTRACT_VERSION,
    runId: input.runId,
    ...decisionFields,
    execution,
    goalGrading,
    observations: [...observations.values()].sort((a, b) =>
      a.evaluatorId < b.evaluatorId ? -1 : a.evaluatorId > b.evaluatorId ? 1 : 0
    ),
  });
}

/** Fold run decisions only, never pool their rates. Empty/partial waves cannot pass. */
export function foldSwarmRunVerdicts(
  verdicts: readonly SwarmSessionVerdictValue[]
): SwarmSessionVerdictValue {
  const values = z.array(swarmSessionVerdictValueSchema).parse(verdicts);
  if (values.includes("failed")) return "failed";
  if (values.includes("inconclusive")) return "inconclusive";
  return values.length > 0 && values.every((value) => value === "passed")
    ? "passed"
    : "notEstablished";
}

/** Lossless target identity in eval's restricted case-id alphabet. Target IDs
 * contain ':' (host:/environment:), which the shared eval validator refuses. */
export function swarmTargetCaseId(targetId: string): string {
  const bytes = new TextEncoder().encode(targetId);
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let encoded = "target_";
  for (let i = 0; i < bytes.length; i += 3) {
    const n =
      (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    encoded += alphabet[(n >>> 18) & 63] + alphabet[(n >>> 12) & 63];
    if (i + 1 < bytes.length) encoded += alphabet[(n >>> 6) & 63];
    if (i + 2 < bytes.length) encoded += alphabet[n & 63];
  }
  return encoded;
}
