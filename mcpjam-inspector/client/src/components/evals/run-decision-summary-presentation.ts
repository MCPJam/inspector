/**
 * The words the browser puts on a canonical run decision summary.
 *
 * ── Every label comes from the contract, none is invented here ───────────────
 *
 * `@mcpjam/sdk/contract` already owns the user-facing spelling of every closed
 * vocabulary this contract uses — the stages, the stage states and reasons, the
 * failure categories, the verdict-policy reasons, the verdicts, the verdict
 * sources, the measurement units, and the undecided reasons. This module does
 * composition and nothing else: it splices those labels into sentences. It
 * deliberately has no `?? value` fallback anywhere, for the reason
 * `decision-labels.ts` gives in its own header — a lookup that prints an
 * unknown enum raw is the failure nobody notices.
 *
 * ── Two words that must not appear on screen ─────────────────────────────────
 *
 *   - **`userValue`.** The wire spelling. A human reads "User value", which is
 *     what `USER_VALUE_STAGE_LABELS` says.
 *   - **"root cause".** The contract establishes where a chain STOPPED, which
 *     is not a claim about why. Everything here says "first failed stage", and
 *     a stage-less outcome (a setup abort, an evaluator error) says so plainly
 *     rather than inventing a stage to hang the sentence on.
 *
 * ── notEstablished is not inconclusive ───────────────────────────────────────
 *
 * `inconclusive` is a verdict the validity phase reached; `notEstablished` is
 * the absence of any verdict. They get different tone, different copy and a
 * different explanation, because folding them together tells a reader a check
 * ran and withheld when nothing ran at all.
 */
import {
  DECISION_SUMMARY_FALLBACK_NEXT_ACTION,
  EVAL_RUN_DECISION_UNDECIDED_REASON_LABELS,
  EVAL_RUN_DECISION_VERDICT_SOURCE_LABELS,
  EVAL_VERDICT_DECISION_REASON_LABELS,
  FAILURE_CATEGORY_LABELS,
  STAGE_REASON_LABELS,
  STAGE_STATE_LABELS,
  USER_VALUE_STAGE_LABELS,
  decisionDiagnosticFailureCategory,
  decisionDiagnosticFirstFailedStage,
  measurementUnitLabel,
  type EvalRunDecisionCounts,
  type EvalRunDecisionDiagnostic,
  type EvalRunDecisionSummary,
  type EvalRunDecisionVerdict,
} from "@mcpjam/sdk/contract";

/** Verdict badge copy. Title case for a badge; the contract's word otherwise. */
export const DECISION_VERDICT_BADGE_LABELS: Record<
  EvalRunDecisionVerdict,
  string
> = {
  passed: "Passed",
  failed: "Failed",
  inconclusive: "Inconclusive",
  notEstablished: "No verdict",
};

/**
 * Tone per verdict.
 *
 * `inconclusive` is amber (a decision was reached and it withheld) and
 * `notEstablished` is neutral (nothing was decided). Giving the second one a
 * warning tone would read as a problem with the server rather than an absence
 * of measurement.
 */
export const DECISION_VERDICT_TONE_CLASS: Record<
  EvalRunDecisionVerdict,
  string
> = {
  passed: "text-success",
  failed: "text-destructive",
  inconclusive: "text-amber-700 dark:text-amber-400",
  notEstablished: "text-muted-foreground",
};

export function decisionVerdictLabel(verdict: EvalRunDecisionVerdict): string {
  return DECISION_VERDICT_BADGE_LABELS[verdict];
}

/** "verdict policy v2" / "legacy percent-threshold run" / "no verdict source". */
export function decisionVerdictSourceLabel(
  summary: EvalRunDecisionSummary,
): string {
  return EVAL_RUN_DECISION_VERDICT_SOURCE_LABELS[summary.verdictSource];
}

/**
 * The counts, with the population they are in stated on them.
 *
 * A legacy run's counts are TRIALS and every field of them is optional, so an
 * absent total stays absent rather than becoming a zero. A policy-v2 run counts
 * case-execution variants and always carries `inconclusive`, which is a real
 * bucket and is never dropped: silently omitting it moves unmeasured cases into
 * neither column.
 */
export function formatDecisionCounts(
  counts: EvalRunDecisionCounts | undefined,
): string | null {
  if (!counts) return null;
  if (counts.measurementUnit === "caseVariant") {
    return (
      `${counts.passed} passed · ${counts.failed} failed · ` +
      `${counts.inconclusive} inconclusive of ${counts.total} ` +
      measurementUnitLabel("caseVariant", counts.total)
    );
  }
  const buckets: string[] = [];
  if (counts.passed !== undefined) buckets.push(`${counts.passed} passed`);
  if (counts.failed !== undefined) buckets.push(`${counts.failed} failed`);
  const total =
    counts.total !== undefined
      ? `${counts.total} ${measurementUnitLabel("trial", counts.total)}`
      : null;
  if (buckets.length === 0) return total;
  return total ? `${buckets.join(" · ")} of ${total}` : buckets.join(" · ");
}

/** The unit's own word, for a column caption beside a number. */
export function decisionMeasurementUnitLabel(
  counts: EvalRunDecisionCounts | undefined,
): string | null {
  if (!counts) return null;
  // A legacy run's total is optional and absence stays absence — but the UNIT
  // is known either way, so the caption still names the population.
  return measurementUnitLabel(counts.measurementUnit, counts.total ?? 0);
}

/** Why the validity phase or the cases decided as they did. One line each. */
export function decisionReasonLines(
  summary: EvalRunDecisionSummary,
): string[] {
  return (summary.decision?.reasons ?? []).map(
    (reason) => EVAL_VERDICT_DECISION_REASON_LABELS[reason],
  );
}

/** Why no verdict was established. Only ever present on `notEstablished`. */
export function decisionUndecidedLine(
  summary: EvalRunDecisionSummary,
): string | null {
  if (!summary.undecided) return null;
  return EVAL_RUN_DECISION_UNDECIDED_REASON_LABELS[summary.undecided.reason];
}

/**
 * Whether validity held, when there is a v2 decision to ask.
 *
 * `null` for a legacy or undecided run: those have no validity phase, and
 * rendering "validity held" for them would claim a check that never ran.
 */
export function decisionValidityHolds(
  summary: EvalRunDecisionSummary,
): boolean | null {
  return summary.decision ? summary.decision.validity.holds : null;
}

export interface DiagnosticChainSummary {
  /** Always starts "First failed stage:" — never "root cause". */
  firstFailedStageLine: string;
  failureCategoryLine: string;
  /**
   * Present when the chain cannot be fully believed: a stored derivation that
   * did not validate, or one produced by an analyzer newer than this build.
   * Flagged, never silently dropped.
   */
  trustNote: string | null;
  /** The six stage rows, when a verified chain carried them. */
  stageLines: string[];
}

/**
 * The stage story for one non-passing trial.
 *
 * The three chain states get three different sentences on purpose.
 * `unverified` means a derivation was offered and rejected, `absent` means none
 * was ever stored, and a verified chain with no first failed stage means the
 * run never reached a stage at all. One shared "unknown" for the three is how
 * "we could not check" gets read as "nothing was wrong".
 */
export function describeDiagnosticChain(
  diagnostic: EvalRunDecisionDiagnostic,
): DiagnosticChainSummary {
  const chain = diagnostic.chain;
  const stage = decisionDiagnosticFirstFailedStage(diagnostic);
  const category = decisionDiagnosticFailureCategory(diagnostic);

  const firstFailedStageLine =
    chain.status === "verified"
      ? stage !== undefined
        ? `First failed stage: ${USER_VALUE_STAGE_LABELS[stage]}${
            firstFailedStageReason(diagnostic, stage)
              ? ` — ${firstFailedStageReason(diagnostic, stage)}`
              : ""
          }`
        : "First failed stage: none was established — the run never reached the server's stages"
      : chain.status === "unverified"
        ? "First failed stage: not established — the recorded stage chain did not validate, so it is withheld"
        : "First failed stage: not established — this run recorded no stage chain";

  const failureCategoryLine =
    category !== undefined
      ? `Failure category: ${FAILURE_CATEGORY_LABELS[category]}`
      : "Failure category: not reported";

  const versionAhead =
    chain.status !== "absent" ? chain.analyzerVersionAhead : undefined;
  const trustNote =
    chain.status === "unverified"
      ? "This trial's stage chain did not validate, so the chain and both claims drawn from it are withheld."
      : versionAhead
        ? `Recorded by stage analyzer v${versionAhead.reported}, newer than the v${versionAhead.known} this build knows. Shown as reported.`
        : null;

  const stageLines =
    chain.status === "verified"
      ? chain.stages.map(
          (row) =>
            `${USER_VALUE_STAGE_LABELS[row.stage]}: ${
              STAGE_STATE_LABELS[row.state]
            }${row.reason ? ` — ${STAGE_REASON_LABELS[row.reason]}` : ""}`,
        )
      : [];

  return { firstFailedStageLine, failureCategoryLine, trustNote, stageLines };
}

function firstFailedStageReason(
  diagnostic: EvalRunDecisionDiagnostic,
  stage: string,
): string | null {
  if (diagnostic.chain.status !== "verified") return null;
  const row = diagnostic.chain.stages.find((entry) => entry.stage === stage);
  return row?.reason ? STAGE_REASON_LABELS[row.reason] : null;
}

/**
 * The evidence locator, in words.
 *
 * Read from the first failed stage's ROW ONLY — the contract already ensured
 * that, and this must not widen it. Unioning the passing stages' spans in here
 * would hand a reader everything that worked, labelled as the evidence for the
 * thing that did not.
 */
export function describeDiagnosticEvidence(
  diagnostic: EvalRunDecisionDiagnostic,
): string | null {
  const { evidence } = diagnostic;
  const parts: string[] = [];
  if (evidence.spanIds) parts.push(`span ids ${evidence.spanIds.join(", ")}`);
  if (evidence.promptIndexes) {
    parts.push(`prompt indexes ${evidence.promptIndexes.join(", ")}`);
  }
  if (evidence.reasons) parts.push(`reasons ${evidence.reasons.join(", ")}`);
  if (parts.length === 0) return null;
  const at = evidence.stage
    ? ` at ${USER_VALUE_STAGE_LABELS[evidence.stage]}`
    : "";
  // Span ids and predicate reasons are authored elsewhere. React escapes them
  // on render; the bound is so one pathological reason cannot swamp the row.
  return `Evidence${at}: ${truncateUntrusted(parts.join("; "), 320) ?? ""}`;
}

/**
 * The operator's next step.
 *
 * Taken from the diagnostic, which the contract already keyed on the failure
 * category alone. When no category was established the contract's own fallback
 * says to go and look rather than naming a system.
 */
export function diagnosticNextAction(
  diagnostic: EvalRunDecisionDiagnostic,
): string {
  return diagnostic.nextAction || DECISION_SUMMARY_FALLBACK_NEXT_ACTION;
}

/**
 * A short, safe rendering of an untrusted string.
 *
 * Case titles, observed failures and server messages are authored elsewhere.
 * React escapes them on render; this only bounds their LENGTH, so one
 * pathological title cannot push the rest of a row off screen. Never used to
 * build markup.
 */
export function truncateUntrusted(
  value: string | undefined | null,
  max = 160,
): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/**
 * How to describe the diagnostics page a reader is looking at.
 *
 * `serverComplete` is the SERVER's claim and is never widened here.
 * `walkExhausted` is this client's separate fact — every cursor offered has
 * been followed — and it is said in different words, because a client that
 * finished its own walk has not learned anything about whether the server
 * considered the set complete.
 */
export function describeDiagnosticsScope(input: {
  shown: number;
  scannedIterations: number;
  serverComplete: boolean;
  walkExhausted: boolean;
}): string {
  const unit = measurementUnitLabel("trial", input.scannedIterations);
  const head = `${input.shown} non-passing of ${input.scannedIterations} ${unit} examined`;
  if (input.serverComplete) return `${head} — this is the run's whole non-passing set.`;
  if (input.walkExhausted) {
    return `${head} — every page offered has been loaded, but the run did not report the set as complete.`;
  }
  return `${head} — partial: more trials have not been examined.`;
}
