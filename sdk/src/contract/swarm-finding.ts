/**
 * Swarm findings wire contract. Enums are stable machine vocabulary, phrase
 * slots contain validated model prose, and code owns identities, populations,
 * citations, verdicts, tones and provenance. Labels live in decision-labels.
 */
import { z } from "zod";
import {
  userValueStageSchema,
  stageStateSchema,
  USER_VALUE_STAGES,
  STAGE_STATES,
} from "./chain.js";
import { swarmSessionVerdictValueSchema } from "./swarm-session-verdict.js";

export const SWARM_FINDING_CONTRACT_VERSION = 1;
export const SWARM_FINDING_DISPOSITIONS = [
  "notRun",
  "blockedConnecting",
  "lostFindingTool",
  "blockedCallingTool",
  "blockedByResponse",
  "goalMissed",
  "goalMetWithFriction",
  "goalMet",
  "notMeasured",
] as const;
export const SWARM_FINDING_TONES = ["fail", "warn", "ok", "muted"] as const;
export const SWARM_FINDING_SUMMARY_KINDS = [
  "notLaunched",
  "broken",
  "friction",
  "landed",
  "ungraded",
  "unread",
] as const;
export const SWARM_FINDING_COVERAGE_NOTES = [
  "sessionScanCapped",
  "budgetExhausted",
  "transcriptMissing",
  "contextTooLarge",
  "extractionRejected",
  "chainUnmeasured",
  "judgeNotRun",
  "sessionsWithdrawn",
  "sessionsRateLimited",
  "partialRead",
  "toolCatalogMissing",
] as const;
export const SWARM_FINDING_SCOPE_LEVELS = [
  "session",
  "goal",
  "persona",
  "target",
  "wave",
] as const;
export const SWARM_FINDING_BASES = [
  "verifiedMechanism",
  "sessionReport",
  "populationFact",
] as const;
export const SWARM_FINDING_CHAIN_STAGE_BASES = [
  "derived",
  "reported",
  "unmeasured",
] as const;
export type SwarmFindingDisposition =
  (typeof SWARM_FINDING_DISPOSITIONS)[number];
export type SwarmFindingTone = (typeof SWARM_FINDING_TONES)[number];
export type SwarmFindingSummaryKind =
  (typeof SWARM_FINDING_SUMMARY_KINDS)[number];
export type SwarmFindingCoverageNote =
  (typeof SWARM_FINDING_COVERAGE_NOTES)[number];
export type SwarmFindingBasis = (typeof SWARM_FINDING_BASES)[number];
export const SWARM_FINDING_TONE_OF_DISPOSITION = Object.freeze({
  notRun: "muted",
  blockedConnecting: "fail",
  lostFindingTool: "fail",
  blockedCallingTool: "fail",
  blockedByResponse: "fail",
  goalMissed: "fail",
  goalMetWithFriction: "warn",
  goalMet: "ok",
  notMeasured: "muted",
} satisfies Record<SwarmFindingDisposition, SwarmFindingTone>);
const vocabulary = (members: readonly string[]) =>
  members.map((value) => "`" + value + "`").join(", ");
const count = z.number().int().nonnegative();
const persona = z
  .object({ personaRefId: z.string().nullable(), name: z.string() })
  .strict();
const disposition = z
  .enum(SWARM_FINDING_DISPOSITIONS)
  .describe(vocabulary(SWARM_FINDING_DISPOSITIONS));
const coverageNotes = z.array(
  z
    .enum(SWARM_FINDING_COVERAGE_NOTES)
    .describe(vocabulary(SWARM_FINDING_COVERAGE_NOTES))
);
const citations = z.array(z.string().regex(/^[^/]+\/.+$/)).max(30);
/**
 * A row's tone is a function of its disposition, never a free field: a
 * producer that sent `goalMet` with `fail` would render a green feeling word
 * on a red row.
 */
const toneMatchesDisposition = (row: {
  disposition: SwarmFindingDisposition;
  tone: SwarmFindingTone;
}) => row.tone === SWARM_FINDING_TONE_OF_DISPOSITION[row.disposition];
const toneMismatch = {
  message: "tone must equal SWARM_FINDING_TONE_OF_DISPOSITION[disposition]",
  path: ["tone"],
};
export const swarmJourneyFindingSchema = z
  .object({
    id: z.string().min(1),
    basis: z
      .enum(SWARM_FINDING_BASES)
      .describe(vocabulary(SWARM_FINDING_BASES)),
    scopeLevel: z
      .enum(SWARM_FINDING_SCOPE_LEVELS)
      .describe(vocabulary(SWARM_FINDING_SCOPE_LEVELS)),
    persona,
    goal: z
      .object({
        runId: z.string(),
        journeyRefId: z.string(),
        title: z.string(),
      })
      .strict(),
    target: z
      .object({
        kind: z.enum(["environment", "host"]),
        id: z.string(),
        label: z.string(),
        modelId: z.string().nullable(),
      })
      .strict(),
    population: z
      .object({ count, total: count, unit: z.literal("sessions") })
      .strict(),
    sessionIds: z.array(z.string()).max(1000),
    citations,
    verdictSeen: swarmSessionVerdictValueSchema,
    chainStage: userValueStageSchema
      .nullable()
      .describe(vocabulary(USER_VALUE_STAGES)),
    chainStageState: stageStateSchema
      .nullable()
      .describe(vocabulary(STAGE_STATES)),
    chainStageBasis: z.enum(SWARM_FINDING_CHAIN_STAGE_BASES),
    disposition,
    tone: z.enum(SWARM_FINDING_TONES),
    coverageNotes,
    outcomePhrase: z
      .string()
      .max(100)
      .regex(/^[^0-9]*$/)
      .refine(
        (value) => value.trim().split(/\s+/).length <= 8,
        "At most eight words"
      )
      .nullable(),
    mechanismPhrase: z.string().nullable(),
    fixPhrase: z.string().nullable(),
    reportExcerpt: z
      .object({ actual: z.string().max(1800), citations })
      .strict()
      .nullable(),
    mechanismId: z.string().nullable(),
  })
  .strict()
  .refine(toneMatchesDisposition, toneMismatch);
export const swarmJourneyFindingsSchema = z
  .object({
    contractVersion: z.literal(SWARM_FINDING_CONTRACT_VERSION),
    generatedAt: count,
    sourceRevision: z.string(),
    pipelineVersion: count,
    extractionVersion: count,
    extractionModel: z.string(),
    reasoningModel: z.string(),
    summaryKind: z
      .enum(SWARM_FINDING_SUMMARY_KINDS)
      .describe(vocabulary(SWARM_FINDING_SUMMARY_KINDS)),
    population: z
      .object({
        configured: count,
        started: count,
        read: count,
        unread: count,
        withdrawn: count,
        limited: count,
        graded: count,
      })
      .strict(),
    coverageNotes,
    disclosure: z
      .object({
        rail: z.enum(["gateway", "openrouter"]),
        evidenceSent: z.array(z.string()),
      })
      .strict(),
    personas: z.array(
      z
        .object({
          persona,
          disposition,
          tone: z.enum(SWARM_FINDING_TONES),
          goalRunIds: z.array(z.string()),
        })
        .strict()
        .refine(toneMatchesDisposition, toneMismatch)
    ),
    findings: z.array(swarmJourneyFindingSchema).max(200),
  })
  .strict();
export const swarmJourneyFindingsJobSchema = z
  .object({
    status: z.enum(["pending", "completed", "failed", "skipped"]),
    errorCode: z.string().optional(),
    updatedAt: count,
  })
  .strict();
export type SwarmJourneyFinding = z.infer<typeof swarmJourneyFindingSchema>;
export type SwarmJourneyFindings = z.infer<typeof swarmJourneyFindingsSchema>;
export type SwarmJourneyFindingsJob = z.infer<
  typeof swarmJourneyFindingsJobSchema
>;
