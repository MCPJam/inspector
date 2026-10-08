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
  "mechanismsRejected",
  "analysisUnavailable",
] as const;
/**
 * A fact the runtime RECORDED about a session — not a model's reading of it.
 * Rows carrying one are population facts: they say what was observed, with no
 * claim about why. Ordered by the priority a session is keyed by, so a reply
 * that was cut off is never filed under the tool error that preceded it.
 */
export const SWARM_FINDING_SIGNALS = [
  "outputTruncated",
  "hallucinatedTool",
  "toolErrored",
  "noToolCalled",
  "turnCapReached",
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
export type SwarmFindingSignal = (typeof SWARM_FINDING_SIGNALS)[number];
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
      .object({
        actual: z.string().max(1800),
        /**
         * The same session in the person's own words — what they tried and
         * what happened to them. Deliberately UNCITED, like `uncertainty`:
         * `actual` is the cited engineering account and stays exactly that.
         */
        account: z.string().max(600).nullable().optional(),
        citations,
      })
      .strict()
      .nullable(),
    mechanismId: z.string().nullable(),
    /**
     * The recorded fact this row reports, when it reports one. Rows sharing a
     * signal fan out per persona, goal and target the way mechanism rows share
     * a `mechanismId`; a reader aggregates by this value.
     */
    signal: z
      .enum(SWARM_FINDING_SIGNALS)
      .describe(vocabulary(SWARM_FINDING_SIGNALS))
      .nullable()
      .optional(),
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
    /**
     * What became of every proposal a model actually made.
     *
     * `proposed === confirmed + rejected + unverified`; each proposal holds
     * exactly one of those states. `omitted` OVERLAPS them — a confirmed cause
     * dropped by a publication cap is confirmed AND omitted — so it is never
     * summed in. `confirmed` may exceed the number of published mechanisms for
     * the same reason.
     *
     * The distinction that matters: `rejected` means something was looked at
     * and did not hold. An analysis that never ran leaves `unverified`, and a
     * wave where the model simply had nothing to say leaves all zeros. Absence
     * is never reported as a rejection.
     */
    verification: z
      .object({
        proposed: count,
        confirmed: count,
        rejected: count,
        unverified: count,
        omitted: count,
      })
      .strict()
      .optional(),
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
