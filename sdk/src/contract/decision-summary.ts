/**
 * The canonical **eval run decision summary** — one versioned shape that says
 * what a run decided, in what unit it counted, and what evidence sits under the
 * non-passing rows.
 *
 * This module is browser-safe and intentionally has no node-only deps.
 *
 * ── What this is for ─────────────────────────────────────────────────────────
 *
 * The six-stage user-value chain shipped as eval metadata, and every surface
 * then interpreted it independently: the API returned rows, the CLI counted
 * iterations and produced its own verdict, the Platform MCP server returned
 * neither, and a reader had to reconstruct the chain from raw tool calls. Three
 * readings of the same run is three chances to disagree about it. This contract
 * is the one reading. The API assembles it, Platform MCP returns it, the CLI
 * renders it, and JSON / JUnit / HTML all restate the same object.
 *
 * ── It EXPLAINS the verdict; it never DECIDES it ─────────────────────────────
 *
 * Nothing here aggregates trials into a verdict. Under verdict policy v2 the
 * authority is the run's own {@link EvalVerdictDecision}: its verdict, its
 * rates, its validity phase, its reasons, its per-case stability and mixed-
 * verdict flags are COPIED after validation and never recomputed from the
 * iteration rows. The one arithmetic this file performs on it is a tally of
 * `decision.cases[].verdict` into {@link EvalRunDecisionCounts}, and the schema
 * refuses a summary whose tally does not match the rows it claims to count —
 * so the counts cannot drift from the decision they summarize.
 *
 * A run that predates policy v2 may project `run.result` + `run.summary`
 * instead, and those counts are TRIALS. Policy-v2 counts are case-execution-
 * VARIANT aggregates. The two are different populations over the same run, and
 * {@link EvalRunDecisionCounts} therefore carries `measurementUnit` on every
 * count it ships. Calling both "cases" — which is what the surfaces did before
 * this contract — makes a 3-case suite with 5 repetitions report either 3 or 15
 * depending on which surface you asked.
 *
 * ── `notEstablished` is a fourth verdict, not a spelling of `failed` ─────────
 *
 * `EVAL_RUN_VERDICTS` has three members because those are the three things a
 * DECIDED run can conclude. A run that is still going, or that stopped without
 * a decision, has concluded none of them, and this contract says so with a
 * fourth word plus an {@link EvalRunDecisionUndecidedReason}. Folding it into
 * `failed` reports a defect nothing observed; folding it into `inconclusive`
 * claims the validity phase ran and withheld a verdict, which it did not.
 *
 * ── Evidence is attached to the claim it supports ───────────────────────────
 *
 * For a measured failure the evidence locator is read from the
 * `firstFailedStage` ROW ONLY. Unioning the span ids of the passing stages into
 * the failure explanation — which is what the previous per-case summary did —
 * hands an operator the spans of everything that worked and labels them as the
 * evidence for the thing that did not. A stage-less outcome (a setup abort, an
 * evaluator error) keeps a stage-less locator: there is a run, an iteration and
 * a trace to read, and inventing a stage to hang the link on would be a claim
 * about where the run broke that nothing established.
 *
 * ── No `.default()`, every object `.strict()` ────────────────────────────────
 *
 * Same discipline as `./suite-file.ts` and `./verdict-policy.ts`, for the same
 * reasons: an omitted field stays omitted so the payload is byte-stable through
 * `canonicalJson`, and an unknown field is an error rather than a silent
 * passenger.
 */

import { z } from "zod";
import {
  failureCategorySchema,
  userValueStageSchema,
  type FailureCategory,
  type UserValueStage,
} from "./chain.js";
import { opaqueIdSchema } from "./identity.js";
import {
  DECISION_SUMMARY_FALLBACK_NEXT_ACTION,
  DECISION_SUMMARY_STALE_ANALYZER_DISAGREEMENT_NEXT_ACTION,
  DECISION_SUMMARY_VERDICT_CHAIN_DISAGREEMENT_NEXT_ACTION,
  NEXT_ACTION_BY_FAILURE_CATEGORY,
} from "./decision-labels.js";
import {
  STAGE_ANALYZER_VERSION,
  STAGE_ANALYZER_VERSION_EVIDENCE_TRIGGERED_RESPONSE,
  stageDerivationSchema,
  stageResultRowSchema,
  type StageResultRow,
} from "./stage-derivation.js";
import {
  evalVerdictDecisionSchema,
  isEvalVerdictPolicyV2,
  type EvalVerdictDecision,
} from "./verdict-policy.js";

/**
 * The contract version, as a literal.
 *
 * `1` because this shape has no predecessor on the wire: the SDK's older
 * `EvalDecisionSummary` was never versioned, never published through the API,
 * and never carried a schema field to bump. A consumer therefore reads
 * `schemaVersion` to know it is looking at this contract at all.
 */
export const EVAL_RUN_DECISION_SUMMARY_SCHEMA_VERSION = 1;
export type EvalRunDecisionSummarySchemaVersion =
  typeof EVAL_RUN_DECISION_SUMMARY_SCHEMA_VERSION;

/** The `$id` of the published JSON Schema for this contract. */
export const EVAL_RUN_DECISION_SUMMARY_SCHEMA_ID =
  "https://mcpjam.com/schemas/eval-run-decision-summary/v1.json";

// ── verdict ──────────────────────────────────────────────────────────────────
/**
 * What a run's decision summary is allowed to report.
 *
 * The first three are `EVAL_RUN_VERDICTS` verbatim — the same three words a
 * decided run concludes. The fourth is this contract's own:
 *
 *   - `notEstablished` — no verdict exists to report. The run has not finished,
 *     or it stopped without one, or its own decision could not be read. NOT a
 *     failure and NOT `inconclusive`: `inconclusive` is a decision the validity
 *     phase reached, and this is the absence of any decision at all. The
 *     accompanying {@link EvalRunDecisionUndecided} says which.
 */
export const EVAL_RUN_DECISION_VERDICTS = [
  "passed",
  "failed",
  "inconclusive",
  "notEstablished",
] as const;
export type EvalRunDecisionVerdict =
  (typeof EVAL_RUN_DECISION_VERDICTS)[number];
export const evalRunDecisionVerdictSchema = z.enum(EVAL_RUN_DECISION_VERDICTS);

/**
 * Where the verdict came from — which is also which evidence a reader may
 * trust.
 *
 *   - `policyV2` — the run's own {@link EvalVerdictDecision}. The summary
 *     carries it verbatim, and `verdict` is its verdict.
 *   - `legacy`   — a percent-threshold run that predates policy v2. There is no
 *     decision object to read, `verdict` is `run.result`, and any counts are
 *     TRIALS.
 *   - `none`     — no verdict. `verdict` is `notEstablished` and `undecided`
 *     says why.
 */
export const EVAL_RUN_DECISION_VERDICT_SOURCES = [
  "policyV2",
  "legacy",
  "none",
] as const;
export type EvalRunDecisionVerdictSource =
  (typeof EVAL_RUN_DECISION_VERDICT_SOURCES)[number];
export const evalRunDecisionVerdictSourceSchema = z.enum(
  EVAL_RUN_DECISION_VERDICT_SOURCES
);

/**
 * What a count counts. Never inferred, never omitted from a count.
 *
 *   - `caseVariant` — one case under one provider/model execution variant, as
 *     aggregated by the run's own decision. This is the population policy v2
 *     decides over: repetitions are TRIALS inside one of these, not members of
 *     it.
 *   - `trial`       — one iteration. What a legacy run's stored `summary`
 *     counted, and what the per-iteration diagnostics below are.
 */
export const EVAL_RUN_MEASUREMENT_UNITS = ["caseVariant", "trial"] as const;
export type EvalRunMeasurementUnit =
  (typeof EVAL_RUN_MEASUREMENT_UNITS)[number];
export const evalRunMeasurementUnitSchema = z.enum(EVAL_RUN_MEASUREMENT_UNITS);

/**
 * Why no verdict was established.
 *
 *   - `runNotTerminal`           — the run is still pending or running. Poll it.
 *   - `runStatusNotAVerdict`     — a legacy run that stopped at `cancelled`,
 *     `timed_out` or `failed`. Its stored summary describes the iterations it
 *     happened to record, not the run it was asked to perform, so gating on it
 *     is fail-open. (A policy-v2 run is NOT resolved this way — see
 *     {@link assembleEvalRunDecisionSummary}.)
 *   - `runResultNotAVerdict`     — a legacy run that completed with no
 *     recognizable `result`.
 *   - `verdictSummaryUnavailable` — the run was decided under policy v2 and its
 *     decision could not be read: absent, or refused by
 *     {@link evalVerdictDecisionSchema}, or accompanied by the platform's own
 *     integrity error (carried in `detail`). A partially-valid decision is
 *     never published, so its absence is the whole answer.
 */
export const EVAL_RUN_DECISION_UNDECIDED_REASONS = [
  "runNotTerminal",
  "runStatusNotAVerdict",
  "runResultNotAVerdict",
  "verdictSummaryUnavailable",
] as const;
export type EvalRunDecisionUndecidedReason =
  (typeof EVAL_RUN_DECISION_UNDECIDED_REASONS)[number];
export const evalRunDecisionUndecidedReasonSchema = z.enum(
  EVAL_RUN_DECISION_UNDECIDED_REASONS
);

export const evalRunDecisionUndecidedSchema = z
  .object({
    reason: evalRunDecisionUndecidedReasonSchema,
    /** The platform's own message, when it supplied one. Never synthesized. */
    detail: z.string().min(1).optional(),
  })
  .strict();
export type EvalRunDecisionUndecided = z.infer<
  typeof evalRunDecisionUndecidedSchema
>;

// ── counts ───────────────────────────────────────────────────────────────────
const countSchema = z.number().int().min(0);

/**
 * A tally, with the population it tallied stated on it.
 *
 * A discriminated union rather than one object with optional members, so
 * `inconclusive` cannot appear on a trial count (a legacy run has no such
 * bucket) and cannot be omitted from a case-variant one (where it is a real
 * outcome, and dropping it silently moves unmeasured cases into neither
 * column).
 */
export const evalRunDecisionCountsSchema = z.discriminatedUnion(
  "measurementUnit",
  [
    z
      .object({
        measurementUnit: z.literal("caseVariant"),
        total: countSchema,
        passed: countSchema,
        failed: countSchema,
        inconclusive: countSchema,
      })
      .strict(),
    z
      .object({
        measurementUnit: z.literal("trial"),
        /**
         * OPTIONAL, because a legacy run's stored summary is optional in every
         * field and absence stays absence: a run that recorded no total has not
         * recorded a total of zero.
         */
        total: countSchema.optional(),
        passed: countSchema.optional(),
        failed: countSchema.optional(),
      })
      .strict(),
  ]
);
export type EvalRunDecisionCounts = z.infer<typeof evalRunDecisionCountsSchema>;

// ── one non-passing iteration ────────────────────────────────────────────────
/**
 * Whether this iteration's chain can be believed.
 *
 *   - `verified`   — the stored derivation validated against
 *     {@link stageDerivationSchema}. Only this variant carries stages, a first
 *     failed stage or a failure category.
 *   - `unverified` — a derivation was stored and did not validate. The chain and
 *     BOTH claims derived from it are withheld: `firstFailedStage` and
 *     `failureCategory` are assertions ABOUT the rows, so rows that do not
 *     validate leave nothing to check them against. Only the quarantine state
 *     crosses, never the rejected claim.
 *   - `absent`     — no derivation was stored at all (an iteration predating the
 *     analyzer). Distinct from `unverified`: nothing was rejected here, nothing
 *     was ever offered.
 */
export const evalRunDecisionChainSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("verified"),
      /** ALWAYS six rows, in `USER_VALUE_STAGES` order. */
      stages: z.array(stageResultRowSchema),
      firstFailedStage: userValueStageSchema.optional(),
      /**
       * The bucket this iteration is grouped under. Present WITHOUT
       * `firstFailedStage` for a setup abort or an evaluator error — both are
       * real answers about a run that never reached a stage, and the contract
       * that produced them says so explicitly.
       */
      failureCategory: failureCategorySchema.optional(),
      analyzerVersion: z.number().int().min(0),
      /**
       * Present when the row was produced by an analyzer NEWER than this build
       * knows. Flagged, never rejected: a version-ahead derivation is still the
       * producer's own answer, and refusing it would blank the chain every time
       * the platform ships ahead of a pinned CLI.
       */
      analyzerVersionAhead: z
        .object({
          reported: z.number().int().min(0),
          known: z.number().int().min(0),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("unverified"),
      analyzerVersion: z.number().int().min(0).optional(),
      analyzerVersionAhead: z
        .object({
          reported: z.number().int().min(0),
          known: z.number().int().min(0),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z.object({ status: z.literal("absent") }).strict(),
]);
export type EvalRunDecisionChain = z.infer<typeof evalRunDecisionChainSchema>;

/**
 * Where to go and look.
 *
 * `tracePath` is the trace endpoint's path RELATIVE TO THE API ROOT — the same
 * relative form `PlatformApiClient` takes, so it resolves against any
 * deployment's base URL rather than baking one host into a stored artifact.
 *
 * `stage` is present only when a first failed stage was established, and the
 * span ids / prompt indexes / reasons are then read from THAT ROW ALONE.
 */
export const evalRunDecisionEvidenceSchema = z
  .object({
    runId: z.string().min(1),
    iterationId: z.string().min(1),
    stage: userValueStageSchema.optional(),
    spanIds: z.array(z.string().min(1)).min(1).optional(),
    promptIndexes: z.array(z.number().int().min(0)).min(1).optional(),
    /** Predicate reasons recorded on the first failed stage's row. */
    reasons: z.array(z.string().min(1)).min(1).optional(),
    tracePath: z.string().min(1),
  })
  .strict();
export type EvalRunDecisionEvidence = z.infer<
  typeof evalRunDecisionEvidenceSchema
>;

/**
 * One non-passing iteration, as evidence beneath the run's verdict.
 *
 * These are TRIALS. They are never counted as cases and never override the
 * run's or a case's verdict — under policy v2 a case can pass with a failing
 * trial in it, and a reader who tallies these rows instead of reading
 * `decision.cases` has re-derived a different verdict from the same run.
 *
 * `caseId` is the case's SDK-DECLARED id when the run recorded one, and
 * `testCaseId` is the stored row id. They are kept apart because they are
 * different identities with different lifetimes. **Neither joins to
 * `decision.cases[].caseId`**, which is an ENCODED identity minted by the
 * platform from whichever spelling that run knew; matching on it here would
 * silently attach a trial to the wrong aggregate.
 */
export const evalRunDecisionDiagnosticSchema = z
  .object({
    iterationId: z.string().min(1),
    iterationNumber: z.number().int().min(0),
    caseId: opaqueIdSchema.optional(),
    testCaseId: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    /** LIFECYCLE, not verdict — see `ITERATION_STATUSES`. */
    status: z.string().min(1),
    /** Task verdict once terminal. Absent when the trial never produced one. */
    result: z.enum(["passed", "failed"]).optional(),
    chain: evalRunDecisionChainSchema,
    expected: z
      .object({ toolNames: z.array(z.string().min(1)).min(1) })
      .strict()
      .optional(),
    observed: z
      .object({
        toolNames: z.array(z.string().min(1)).min(1).optional(),
        failure: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    evidence: evalRunDecisionEvidenceSchema,
    nextAction: z.string().min(1),
  })
  .strict();
export type EvalRunDecisionDiagnostic = z.infer<
  typeof evalRunDecisionDiagnosticSchema
>;

/**
 * One page of diagnostics, with its completeness stated rather than implied.
 *
 * `complete` is the load-bearing field and it means exactly one thing: `items`
 * is the WHOLE non-passing set for this run. A page reached through a cursor is
 * never complete, and neither is the last page of a walk that was cut short. A
 * partial page that claimed to be a complete failure list would let a reader
 * conclude "only these two cases failed" from a sample — the same confident-
 * verdict-about-page-one failure the CLI's iteration walk already guards.
 *
 * `scannedIterations` is how many iterations this page examined. It is what
 * separates "we looked at 50 and none of them failed" from "we did not look",
 * both of which otherwise render as an empty `items`.
 */
export const evalRunDecisionDiagnosticsSchema = z
  .object({
    items: z.array(evalRunDecisionDiagnosticSchema),
    complete: z.boolean(),
    nextCursor: z.string().min(1).optional(),
    scannedIterations: countSchema,
  })
  .strict()
  .superRefine((page, ctx) => {
    if (page.complete && page.nextCursor !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["nextCursor"],
        message:
          "a complete diagnostics page has no next cursor: more pages means " +
          "the set is not complete",
      });
    }
    if (page.items.length > page.scannedIterations) {
      ctx.addIssue({
        code: "custom",
        path: ["scannedIterations"],
        message:
          `scannedIterations ${page.scannedIterations} is fewer than the ` +
          `${page.items.length} diagnostics drawn from them`,
      });
    }
  });
export type EvalRunDecisionDiagnostics = z.infer<
  typeof evalRunDecisionDiagnosticsSchema
>;

// ── the summary ──────────────────────────────────────────────────────────────
export const evalRunDecisionSummaryStructuralSchema = z
  .object({
    schemaVersion: z.literal(EVAL_RUN_DECISION_SUMMARY_SCHEMA_VERSION),
    runId: z.string().min(1),
    /** The run's lifecycle status, verbatim. Not a verdict. */
    runStatus: z.string().min(1),
    verdict: evalRunDecisionVerdictSchema,
    verdictSource: evalRunDecisionVerdictSourceSchema,
    counts: evalRunDecisionCountsSchema.optional(),
    /**
     * The run's authoritative v2 decision, copied after validation.
     *
     * Present exactly when `verdictSource` is `policyV2`. Nothing in this
     * contract recomputes any field of it.
     */
    decision: evalVerdictDecisionSchema.optional(),
    undecided: evalRunDecisionUndecidedSchema.optional(),
    diagnostics: evalRunDecisionDiagnosticsSchema,
  })
  .strict();

/**
 * The summary validator, with the cross-field rules that make the envelope
 * self-consistent.
 *
 * These are CONSISTENCY checks on a supplied summary, in the same spirit as
 * `evalVerdictDecisionSchema`: they refuse a payload whose headline does not
 * follow from the evidence shipped beside it. The one that matters most is the
 * count tally — it is what stops a renderer's "2/3 passed" from drifting away
 * from the decision it claims to be reading.
 */
export const evalRunDecisionSummarySchema =
  evalRunDecisionSummaryStructuralSchema.superRefine((summary, ctx) => {
    const fail = (path: PropertyKey[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });

    if (summary.verdictSource === "policyV2") {
      if (summary.decision === undefined) {
        fail(
          ["decision"],
          `verdictSource "policyV2" requires the decision it names as the authority`
        );
        return;
      }
      if (summary.verdict !== summary.decision.verdict) {
        fail(
          ["verdict"],
          `verdict "${summary.verdict}" must be the decision's own verdict ` +
            `"${summary.decision.verdict}" — this contract explains a decision, ` +
            `it never re-decides one`
        );
      }
      if (summary.undecided !== undefined) {
        fail(["undecided"], `a decided run has no undecided reason`);
      }
      const counts = summary.counts;
      if (counts === undefined || counts.measurementUnit !== "caseVariant") {
        fail(
          ["counts"],
          `a policy-v2 summary counts case-execution variants, not ` +
            `${counts?.measurementUnit ?? "nothing"}`
        );
        return;
      }
      const tally = tallyCaseVariants(summary.decision);
      if (
        counts.total !== tally.total ||
        counts.passed !== tally.passed ||
        counts.failed !== tally.failed ||
        counts.inconclusive !== tally.inconclusive
      ) {
        fail(
          ["counts"],
          `counts must be the tally of decision.cases[].verdict ` +
            `(${tally.passed} passed / ${tally.failed} failed / ` +
            `${tally.inconclusive} inconclusive of ${tally.total})`
        );
      }
      return;
    }

    if (summary.decision !== undefined) {
      fail(
        ["decision"],
        `only a "policyV2" summary carries a decision; this one is ` +
          `"${summary.verdictSource}"`
      );
    }

    if (summary.verdictSource === "legacy") {
      if (summary.verdict !== "passed" && summary.verdict !== "failed") {
        fail(
          ["verdict"],
          `a legacy run's verdict is its own "passed" or "failed"; ` +
            `"${summary.verdict}" is not one a percent-threshold run can reach`
        );
      }
      if (summary.undecided !== undefined) {
        fail(["undecided"], `a decided run has no undecided reason`);
      }
      if (
        summary.counts !== undefined &&
        summary.counts.measurementUnit !== "trial"
      ) {
        fail(
          ["counts"],
          `a legacy run's stored summary counts trials, not ` +
            `${summary.counts.measurementUnit}`
        );
      }
      return;
    }

    // verdictSource === "none"
    if (summary.verdict !== "notEstablished") {
      fail(
        ["verdict"],
        `with no verdict source the verdict is "notEstablished", not ` +
          `"${summary.verdict}"`
      );
    }
    if (summary.undecided === undefined) {
      fail(
        ["undecided"],
        `an undecided run must say which check left it undecided`
      );
    }
    if (summary.counts !== undefined) {
      fail(
        ["counts"],
        `a run with no verdict reports no counts: the numbers it happens to ` +
          `have recorded describe a decision nobody took`
      );
    }
  });
export type EvalRunDecisionSummary = z.infer<
  typeof evalRunDecisionSummarySchema
>;

/** The case-variant tally, derived from the decision's own rows and nothing else. */
function tallyCaseVariants(decision: EvalVerdictDecision): {
  total: number;
  passed: number;
  failed: number;
  inconclusive: number;
} {
  let passed = 0;
  let failed = 0;
  let inconclusive = 0;
  for (const entry of decision.cases) {
    if (entry.verdict === "passed") passed += 1;
    else if (entry.verdict === "failed") failed += 1;
    else inconclusive += 1;
  }
  return { total: decision.cases.length, passed, failed, inconclusive };
}

// ── assembly ─────────────────────────────────────────────────────────────────
//
// Structural, minimal input shapes rather than imports of the platform DTOs,
// following `./stage-derivation.ts`: this module is consumed from the SDK, the
// inspector server and the client bundle, and `PlatformEvalRun` /
// `PlatformEvalIteration` satisfy these by construction.

/** The already-public run fields a summary reads. Nothing else. */
export type EvalRunDecisionRunInput = {
  id: string;
  status: string;
  result?: string | null;
  summary?: {
    total?: number;
    passed?: number;
    failed?: number;
  } | null;
  verdictPolicyVersion?: unknown;
  verdictSummary?: unknown;
  verdictPolicyIntegrityError?: unknown;
};

/** The already-public iteration fields a diagnostic reads. Nothing else. */
export type EvalRunDecisionIterationInput = {
  id: string;
  iterationNumber: number;
  status: string;
  result?: string | null;
  /** The case's SDK-declared id, when the run recorded one. */
  caseId?: string | null;
  /** The stored case row id. */
  testCaseId?: string | null;
  title?: string | null;
  expectedToolCalls?: readonly unknown[];
  actualToolCalls?: readonly unknown[];
  error?: string | null;
  stageResults?: unknown;
  firstFailedStage?: unknown;
  failureCategory?: unknown;
  stageAnalyzerVersion?: unknown;
  stageResultsUnverified?: unknown;
};

export type EvalRunDecisionAssemblyInput = {
  /** Needed only to build the trace path; never stored on the summary. */
  projectId: string;
  run: EvalRunDecisionRunInput;
  /** ONE page of iterations, in the order the API returned them. */
  iterations: readonly EvalRunDecisionIterationInput[];
  page: {
    /** True only when `iterations` is the run's whole set. */
    complete: boolean;
    nextCursor?: string;
  };
};

/**
 * Statuses at which a run has stopped changing.
 *
 * Mirrors the CLI's `TERMINAL_RUN_STATUSES`; kept here because the summary is
 * assembled on the server too, and a server that read "still running" as
 * "no verdict" for a finished run would report `notEstablished` forever.
 */
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

/**
 * Terminal statuses at which a LEGACY run's stored summary describes the
 * iterations it happened to record rather than the run it was asked to perform.
 *
 * Applied to legacy runs ONLY. A policy-v2 run is not resolved this way: its
 * validity phase is precisely where lifecycle enters the verdict (cancelled
 * trials are withdrawn from every denominator, unattempted configured trials
 * make the run `inconclusive`), and second-guessing that here would replace the
 * suite author's configured coverage rule with one this file invented.
 */
const LEGACY_NON_VERDICT_STATUSES: ReadonlySet<string> = new Set([
  "cancelled",
  "timed_out",
  "failed",
]);

/**
 * Build the canonical summary from one already-projected run and one page of
 * already-projected iterations.
 *
 * PURE: no network, no pagination, no clock. The API route and the SDK's
 * compatibility fallback both call THIS function, which is what makes their
 * output byte-equivalent for the same input — the alternative, two assemblers
 * that agree today, is the drift this whole lane exists to remove.
 */
export function assembleEvalRunDecisionSummary(
  input: EvalRunDecisionAssemblyInput
): EvalRunDecisionSummary {
  const { run } = input;
  const diagnostics = assembleDiagnostics(input);

  const base = {
    schemaVersion: EVAL_RUN_DECISION_SUMMARY_SCHEMA_VERSION,
    runId: run.id,
    runStatus: run.status,
    diagnostics,
  } as const;

  const undecided = (
    reason: EvalRunDecisionUndecidedReason,
    detail?: string
  ): EvalRunDecisionSummary => ({
    ...base,
    verdict: "notEstablished",
    verdictSource: "none",
    undecided: { reason, ...(detail ? { detail } : {}) },
  });

  if (!TERMINAL_RUN_STATUSES.has(run.status)) {
    return undecided("runNotTerminal");
  }

  if (isEvalVerdictPolicyV2(run.verdictPolicyVersion)) {
    const parsed = evalVerdictDecisionSchema.safeParse(run.verdictSummary);
    if (!parsed.success) {
      const detail =
        typeof run.verdictPolicyIntegrityError === "string" &&
        run.verdictPolicyIntegrityError.length > 0
          ? run.verdictPolicyIntegrityError
          : undefined;
      return undecided("verdictSummaryUnavailable", detail);
    }
    const decision = parsed.data;
    const tally = tallyCaseVariants(decision);
    return {
      ...base,
      verdict: decision.verdict,
      verdictSource: "policyV2",
      counts: { measurementUnit: "caseVariant", ...tally },
      decision,
    };
  }

  if (LEGACY_NON_VERDICT_STATUSES.has(run.status)) {
    return undecided("runStatusNotAVerdict");
  }
  if (run.result !== "passed" && run.result !== "failed") {
    return undecided("runResultNotAVerdict");
  }

  const counts = legacyTrialCounts(run.summary);
  return {
    ...base,
    verdict: run.result,
    verdictSource: "legacy",
    ...(counts ? { counts } : {}),
  };
}

/**
 * Project a legacy run's stored summary as TRIAL counts.
 *
 * Field by field, and absence stays absence: a run that recorded no `failed`
 * has not recorded zero failures, and defaulting it would manufacture a clean
 * bill of health out of a missing field. `passRate` is deliberately not carried
 * — it is stored without a documented scale, and a number a renderer cannot
 * label is worse than one it does not have.
 */
function legacyTrialCounts(
  summary: EvalRunDecisionRunInput["summary"]
): EvalRunDecisionCounts | undefined {
  if (!summary || typeof summary !== "object") return undefined;
  const count = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isInteger(value) && value >= 0
      ? value
      : undefined;
  const total = count(summary.total);
  const passed = count(summary.passed);
  const failed = count(summary.failed);
  if (total === undefined && passed === undefined && failed === undefined) {
    return undefined;
  }
  return {
    measurementUnit: "trial",
    ...(total !== undefined ? { total } : {}),
    ...(passed !== undefined ? { passed } : {}),
    ...(failed !== undefined ? { failed } : {}),
  };
}

function assembleDiagnostics(
  input: EvalRunDecisionAssemblyInput
): EvalRunDecisionDiagnostics {
  const items = input.iterations
    .filter((iteration) => iteration.result !== "passed")
    .map((iteration) => assembleDiagnostic(input, iteration));
  return {
    items,
    complete: input.page.complete,
    ...(input.page.nextCursor ? { nextCursor: input.page.nextCursor } : {}),
    scannedIterations: input.iterations.length,
  };
}

function assembleDiagnostic(
  input: EvalRunDecisionAssemblyInput,
  iteration: EvalRunDecisionIterationInput
): EvalRunDecisionDiagnostic {
  const chain = assembleChain(iteration);
  const category =
    chain.status === "verified" ? chain.failureCategory : undefined;
  const expected = toolNames(iteration.expectedToolCalls);
  const observedNames = toolNames(iteration.actualToolCalls);
  const failure = nonEmptyString(iteration.error);
  const caseId = opaqueIdSchema.safeParse(iteration.caseId);

  return {
    iterationId: iteration.id,
    iterationNumber: iteration.iterationNumber,
    ...(caseId.success ? { caseId: caseId.data } : {}),
    ...(nonEmptyString(iteration.testCaseId)
      ? { testCaseId: String(iteration.testCaseId) }
      : {}),
    ...(nonEmptyString(iteration.title)
      ? { title: String(iteration.title) }
      : {}),
    status: iteration.status,
    ...(iteration.result === "passed" || iteration.result === "failed"
      ? { result: iteration.result }
      : {}),
    chain,
    ...(expected ? { expected: { toolNames: expected } } : {}),
    ...(observedNames || failure
      ? {
          observed: {
            ...(observedNames ? { toolNames: observedNames } : {}),
            ...(failure ? { failure } : {}),
          },
        }
      : {}),
    evidence: assembleEvidence(input, iteration, chain),
    nextAction: category
      ? NEXT_ACTION_BY_FAILURE_CATEGORY[category]
      : uncategorisedNextAction(chain, iteration.result),
  };
}

/**
 * What to tell a reader when the chain established no failure category.
 *
 * Two of these runs are not the same thing, and the old single line described
 * both as an absence of information:
 *
 *   - The chain measured everything it could and found nothing wrong, while
 *     the recorded verdict says failed. That is not missing information — it
 *     is two things we hold disagreeing, which is a different investigation.
 *   - Anything else (an unverified chain, a stage that never measured, a run
 *     that did not fail): no category and nothing more to say.
 *
 * The disagreement is asserted only when all four halves of it are
 * STRUCTURALLY established: the chain validated, at least one stage actually
 * passed, every applicable stage passed, and the verdict is `failed`. Nothing
 * here guesses at a cause — the chain cannot see one from here, and a guess
 * dressed as a finding is what this vocabulary exists to prevent.
 */
function uncategorisedNextAction(
  chain: EvalRunDecisionChain,
  result: EvalRunDecisionIterationInput["result"]
): string {
  if (chain.status !== "verified" || result !== "failed") {
    return DECISION_SUMMARY_FALLBACK_NEXT_ACTION;
  }
  // A disagreement needs the chain to be COMPLETE and clean, not merely
  // un-failed. Every stage must have `passed`, except the ones the case does
  // not exercise at all.
  //
  // "Something passed and nothing failed" is too weak, and its gap is the same
  // mistake in slower motion: a chain with connection and discovery passed and
  // selection `notMeasured / noEvidenceCaptured` has nothing failed and
  // something measured, but the verdict may be failing on exactly the stage
  // the chain could not read. That is a measurement GAP, and telling someone
  // two things they hold are in conflict sends them looking for a
  // contradiction that is not there.
  //
  // `notApplicable` is the one state that does not block the claim: a stage
  // the case never exercises is not missing evidence, it is out of scope, and
  // requiring it to pass would make the claim unreachable for every case that
  // does not use all six stages.
  const measuredSomething = chain.stages.some((row) => row.state === "passed");
  const everyApplicableStagePassed = chain.stages.every(
    (row) => row.state === "passed" || row.state === "notApplicable"
  );
  if (!measuredSomething || !everyApplicableStagePassed) {
    return DECISION_SUMMARY_FALLBACK_NEXT_ACTION;
  }

  // A pre-7 chain gets a different INSTRUCTION, not a different diagnosis.
  //
  // The version establishes that this analyzer measured strictly less than the
  // current one — before 7 an errored tool call on a case with no authored
  // tool expectation had no stage able to report it — so re-deriving may
  // attribute what this row could not. It does NOT establish that such a call
  // occurred, which is why the wording names the analyzer and not a cause.
  return chain.analyzerVersion !== undefined &&
    chain.analyzerVersion < STAGE_ANALYZER_VERSION_EVIDENCE_TRIGGERED_RESPONSE
    ? DECISION_SUMMARY_STALE_ANALYZER_DISAGREEMENT_NEXT_ACTION
    : DECISION_SUMMARY_VERDICT_CHAIN_DISAGREEMENT_NEXT_ACTION;
}

/**
 * One iteration's stage rows, as the chain a reader may believe.
 *
 * EXPORTED because a second surface needs the SAME answer. D9's diagnostics
 * cover non-passing trials only — the filter is deliberate and lives in
 * `assembleDiagnostics` — so a reader that wants a PASSING trial's chain has
 * to go to the iterations resource, and it must arrive at `verified` /
 * `unverified` / `absent` by exactly this route.
 *
 * The whole DERIVATION is parsed, never the rows one at a time. Row-level
 * validation accepts five rows, or six in the wrong order, and a renderer that
 * numbers cards by position would then publish a different claim about which
 * stages were blocked — `notReached` is derived from POSITION. The
 * six-rows-in-order refinement lives in `stageDerivationSchema`, and this is
 * the only client-reachable way to apply it.
 */
export function assembleEvalRunDecisionChain(
  iteration: EvalRunDecisionIterationInput
): EvalRunDecisionChain {
  return assembleChain(iteration);
}

function assembleChain(
  iteration: EvalRunDecisionIterationInput
): EvalRunDecisionChain {
  const reported = analyzerVersion(iteration.stageAnalyzerVersion);
  const ahead =
    reported !== undefined && reported > STAGE_ANALYZER_VERSION
      ? { analyzerVersionAhead: { reported, known: STAGE_ANALYZER_VERSION } }
      : {};

  const derivation = stageDerivationSchema.safeParse({
    stageResults: iteration.stageResults,
    ...(iteration.firstFailedStage !== undefined
      ? { firstFailedStage: iteration.firstFailedStage }
      : {}),
    ...(iteration.failureCategory !== undefined
      ? { failureCategory: iteration.failureCategory }
      : {}),
    stageAnalyzerVersion: iteration.stageAnalyzerVersion,
  });

  if (derivation.success) {
    return {
      status: "verified",
      stages: derivation.data.stageResults,
      ...(derivation.data.firstFailedStage
        ? { firstFailedStage: derivation.data.firstFailedStage }
        : {}),
      ...(derivation.data.failureCategory
        ? { failureCategory: derivation.data.failureCategory }
        : {}),
      analyzerVersion: derivation.data.stageAnalyzerVersion,
      ...ahead,
    };
  }

  // A derivation was OFFERED (either the rows are present, or the server told
  // us it quarantined them) and it did not validate: quarantine state only.
  if (
    iteration.stageResultsUnverified === true ||
    iteration.stageResults !== undefined
  ) {
    return {
      status: "unverified",
      ...(reported !== undefined ? { analyzerVersion: reported } : {}),
      ...ahead,
    };
  }
  return { status: "absent" };
}

/**
 * The locator for one diagnostic.
 *
 * The span ids, prompt indexes and reasons come from the FIRST FAILED STAGE'S
 * ROW and from nowhere else. Collecting them across the whole chain — which the
 * SDK's older summary did — hands back the evidence of every stage that
 * WORKED, presented as the evidence for the one that did not.
 */
function assembleEvidence(
  input: EvalRunDecisionAssemblyInput,
  iteration: EvalRunDecisionIterationInput,
  chain: EvalRunDecisionChain
): EvalRunDecisionEvidence {
  const base = {
    runId: input.run.id,
    iterationId: iteration.id,
    tracePath: evalIterationTracePath(
      input.projectId,
      input.run.id,
      iteration.id
    ),
  };
  if (chain.status !== "verified" || chain.firstFailedStage === undefined) {
    return base;
  }
  const row: StageResultRow | undefined = chain.stages.find(
    (candidate) => candidate.stage === chain.firstFailedStage
  );
  const spanIds = dedupeStrings(row?.evidence?.spanIds);
  const promptIndexes = dedupeIndexes(row?.evidence?.promptIndexes);
  const reasons = dedupeStrings(row?.evidence?.predicateReasons);
  return {
    ...base,
    stage: chain.firstFailedStage,
    ...(spanIds ? { spanIds } : {}),
    ...(promptIndexes ? { promptIndexes } : {}),
    ...(reasons ? { reasons } : {}),
  };
}

/**
 * The iteration-trace endpoint, relative to the API root.
 *
 * One definition, so the path a summary hands a reader is the same path the
 * SDK client would call. Exported because the CLI prints it and the docs cite
 * it.
 */
export function evalIterationTracePath(
  projectId: string,
  runId: string,
  iterationId: string
): string {
  return (
    `/projects/${encodeURIComponent(projectId)}` +
    `/eval-runs/${encodeURIComponent(runId)}` +
    `/iterations/${encodeURIComponent(iterationId)}/trace`
  );
}

function analyzerVersion(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toolName(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return (
    nonEmptyString(record.toolName) ??
    nonEmptyString(record.tool) ??
    nonEmptyString(record.name)
  );
}

function toolNames(
  calls: readonly unknown[] | undefined
): string[] | undefined {
  const names = (calls ?? [])
    .map(toolName)
    .filter((name): name is string => name !== undefined);
  return names.length > 0 ? [...new Set(names)] : undefined;
}

function dedupeStrings(
  values: readonly string[] | undefined
): string[] | undefined {
  const unique = [
    ...new Set((values ?? []).filter((value) => value.length > 0)),
  ];
  return unique.length > 0 ? unique : undefined;
}

function dedupeIndexes(
  values: readonly number[] | undefined
): number[] | undefined {
  const unique = [
    ...new Set(
      (values ?? []).filter((value) => Number.isInteger(value) && value >= 0)
    ),
  ];
  return unique.length > 0 ? unique : undefined;
}

/** The failure category a diagnostic was grouped under, when one was verified. */
export function decisionDiagnosticFailureCategory(
  diagnostic: EvalRunDecisionDiagnostic
): FailureCategory | undefined {
  return diagnostic.chain.status === "verified"
    ? diagnostic.chain.failureCategory
    : undefined;
}

/** The first failed stage a diagnostic established, when one was verified. */
export function decisionDiagnosticFirstFailedStage(
  diagnostic: EvalRunDecisionDiagnostic
): UserValueStage | undefined {
  return diagnostic.chain.status === "verified"
    ? diagnostic.chain.firstFailedStage
    : undefined;
}

// ── the words for THIS contract's own vocabularies ───────────────────────────
//
// `./decision-labels.ts` is the home for the labels of vocabularies declared
// ELSEWHERE (the chain, the stage reasons, the verdict-policy reasons) — the
// ones whose definition sits in another file and can therefore be widened
// without anybody noticing the renderers. The four below are declared in THIS
// file, so they live beside their enums: adding a member and forgetting its
// words would mean editing this file and skipping the block underneath.

/** @see EVAL_RUN_DECISION_VERDICTS */
export const EVAL_RUN_DECISION_VERDICT_LABELS = Object.freeze({
  passed: "passed",
  failed: "failed",
  inconclusive: "inconclusive",
  notEstablished: "no verdict established",
} satisfies Record<EvalRunDecisionVerdict, string>);

/** @see EVAL_RUN_DECISION_VERDICT_SOURCES */
export const EVAL_RUN_DECISION_VERDICT_SOURCE_LABELS = Object.freeze({
  policyV2: "verdict policy v2",
  legacy: "legacy percent-threshold run",
  none: "no verdict source",
} satisfies Record<EvalRunDecisionVerdictSource, string>);

/**
 * @see EVAL_RUN_MEASUREMENT_UNITS
 *
 * Singular and plural, because a count is always rendered next to its unit and
 * "1 case variants" is the kind of wrongness that makes a reader distrust the
 * number beside it.
 */
export const EVAL_RUN_MEASUREMENT_UNIT_LABELS = Object.freeze({
  caseVariant: { one: "case variant", many: "case variants" },
  trial: { one: "trial", many: "trials" },
} satisfies Record<EvalRunMeasurementUnit, { one: string; many: string }>);

/** @see EVAL_RUN_DECISION_UNDECIDED_REASONS */
export const EVAL_RUN_DECISION_UNDECIDED_REASON_LABELS = Object.freeze({
  runNotTerminal: "the run has not finished yet",
  runStatusNotAVerdict:
    "the run stopped before it finished, so its recorded counts describe a sample rather than the run",
  runResultNotAVerdict: "the run finished without recording a verdict",
  verdictSummaryUnavailable:
    "the run was decided under verdict policy v2 and its decision could not be read",
} satisfies Record<EvalRunDecisionUndecidedReason, string>);

/** The unit's word for `count`, singular or plural. */
export function measurementUnitLabel(
  unit: EvalRunMeasurementUnit,
  count: number
): string {
  const words = EVAL_RUN_MEASUREMENT_UNIT_LABELS[unit];
  return count === 1 ? words.one : words.many;
}
