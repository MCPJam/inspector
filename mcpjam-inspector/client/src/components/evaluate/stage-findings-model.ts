/**
 * The join between D5c's stage tallies and D9's per-trial diagnostics.
 *
 * PURE — no React, no fetching, no clock. Two validated documents in, one
 * render model out, so every attribution rule below is testable without a DOM.
 *
 * ── What this is allowed to claim ────────────────────────────────────────────
 *
 * D5c says HOW MANY trials failed at each stage. D9 says WHICH trials did not
 * pass, and carries the human material — the case title, the observed failure
 * string, the tool names, the trace locator, the next action. Neither document
 * points at the other, and this module is the join: for a stage S, the
 * diagnostics whose own verified chain records S as `failed`.
 *
 * That is the ONLY attribution rule here, and it is a lookup rather than an
 * inference. A diagnostic is attached to S because its chain row for S says
 * `failed` — not because its failure category sounds like S, not because it is
 * the only failure in the run, and never because a stage needed an example.
 *
 * ── What it must never do ────────────────────────────────────────────────────
 *
 *   - **Invent a stage.** A diagnostic with no failed stage row — a setup
 *     abort, an evaluator error, an unverified or absent chain — goes to a
 *     run-level bucket that says so. Guessing would put a real trial's error
 *     text under a stage nothing measured it at.
 *   - **State a verdict.** The run's verdict is D9's card's to state. Nothing
 *     here reads `summary.verdict`.
 *   - **Overwrite a tally.** When the counts disagree with the tally D5c
 *     computed, this reports the disagreement and leaves the tally standing.
 *     The materializer counted the whole run; a diagnostics page may have
 *     scanned part of it, so the tally is the better number and a
 *     silently-corrected one would be worse than either.
 *   - **Diagnose.** Every evidence line is composed from fields the contract
 *     carries. There is no sentence here that was not read off a document.
 */
import {
  STAGE_REASONS,
  STAGE_REASON_LABELS,
  USER_VALUE_STAGE_LABELS,
  decisionDiagnosticFirstFailedStage,
  type EvalRunDecisionDiagnostic,
  type EvalRunDecisionSummary,
  type EvalStageAnalyticsV1,
  type EvalStageTally,
  type StageReason,
  type UserValueStage,
} from "@mcpjam/sdk/contract";
import {
  describeScanScope,
  isDiagnosticTraceable,
  truncateUntrusted,
} from "../evals/run-decision-summary-presentation";

/** How many groups a stage shows before the rest go behind an expander. */
export const STAGE_FINDING_GROUP_CAP = 3;
/** How many example trials a group shows before the rest do. */
export const STAGE_FINDING_TRIAL_CAP = 3;

/** One non-passing trial, as evidence under a stage. */
export interface StageFindingTrial {
  iterationId: string;
  iterationNumber: number;
  /** The case title, bounded. `null` when the run recorded none. */
  title: string | null;
  /** The observed failure string, bounded. Untrusted; React escapes it. */
  observedFailure: string | null;
  /**
   * Expected vs observed tool names, for the two stages where they are the
   * finding rather than decoration. Absent everywhere else — a tool name under
   * a `connection` failure is noise a reader has to rule out.
   */
  expectedTools: string[] | null;
  observedTools: string[] | null;
  /**
   * Whether an EARLIER stage also failed on this trial.
   *
   * A trial can be a non-primary appearance: its chain failed at `selection`
   * and again at `userValue`, so it shows under both. Said out loud, because
   * a reader who takes the later row for the origin goes after the wrong link.
   */
  earlierStageAlsoFailed: boolean;
  /** Whether this trial's evidence can actually be opened from this run. */
  traceable: boolean;
  testCaseId: string | null;
  runId: string;
}

/**
 * The words for a failed row that recorded no reason.
 *
 * `stageResultRowSchema` makes `reason` OPTIONAL, so a verified `failed` row
 * can legitimately carry none. Substituting a real `StageReason` for the
 * absence — `noEvidenceCaptured` was the first draft — states a specific cause
 * the run never recorded, under a label a reader would take as measured. It is
 * the same invention this module refuses everywhere else, so the absence gets
 * its own group and says what it is.
 */
export const STAGE_REASON_NOT_RECORDED_LABEL =
  "the run recorded no reason for this failure";

/** Trials that failed a stage for the same reason, grouped. */
export interface StageFindingGroup {
  /** `null` when the row recorded no reason. NEVER a substituted one. */
  reason: StageReason | null;
  /** A stable key for a React list and a `data-` attribute. */
  key: string;
  label: string;
  count: number;
  /** Every trial in the group; the view caps what it shows. */
  trials: StageFindingTrial[];
  /**
   * The operator's next step, from the diagnostics themselves.
   *
   * Already authored per failure category in the contract and carried on every
   * diagnostic, so this reuses the field rather than inventing a vocabulary.
   * `null` when the group's trials do not agree on one — two categories under
   * one reason is a real thing, and picking one of them would be a guess.
   */
  nextAction: string | null;
}

export interface StageFindings {
  stage: UserValueStage;
  groups: StageFindingGroup[];
  /** "Response failed in 2 of 3 measured trials." Population before anything. */
  headline: string;
  /** "over all 7 scanned trials" / "over the first 20 … not the complete set". */
  scopeLine: string;
  /**
   * Stage failures the tally counted that no diagnostic here explains.
   *
   * The trap this exists for: **D9 enumerates NON-PASSING trials only**, while
   * D5c tallies stage failures over every included trial. Under policy v2 a
   * case can pass with a failing trial in it, so a trial can fail a stage while
   * its case passes — and it will then have no diagnostic row at all. Silence
   * here would read as "we found nothing", when what happened is that the rows
   * exist and are not in this set.
   */
  unattributedNote: string | null;
  /**
   * Set when the attributed count EXCEEDS the tally under a complete scan.
   *
   * Never resolved by overwriting the tally: the materializer counted the whole
   * run and this join counted a page of it, so a disagreement is something to
   * report and look at, not something to average away.
   */
  reconciliationNote: string | null;
}

/** One non-passing trial that no stage row accounts for. */
export interface RunLevelFinding {
  count: number;
  /** "3 non-passing trials are not attributable to a stage." */
  line: string;
}

/**
 * What the findings section is showing, as one closed union.
 *
 * Every degraded state is its own variant rather than an empty `ready`. "The
 * flag is off", "the read is in flight", "the read failed", "this run predates
 * the contract" and "we found nothing" are five different things to know, and
 * the one thing none of them may look like is the last one.
 */
export type StageFindingsState =
  /** The decision-summary read is off here. Render nothing at all. */
  | { kind: "disabled" }
  | { kind: "loading" }
  /** The read failed. The stage cards and rates above are unaffected. */
  | { kind: "unavailable"; title: string; detail: string }
  /** A legacy or verdict-less run: the contract has no diagnostics for it. */
  | { kind: "noDecisionDiagnostics" }
  /** Still running. Nothing has been decided to have diagnostics about. */
  | { kind: "runNotTerminal" }
  /**
   * The two documents describe different runs.
   *
   * Renders as NOTHING rather than as an error: this is what a mid-navigation
   * frame looks like when one read has landed for the new run and the other
   * still holds the old one, and an alarming message for a state that resolves
   * itself on the next tick would train a reader to ignore it.
   */
  | { kind: "identityMismatch" }
  | {
      kind: "ready";
      byStage: Record<string, StageFindings | undefined>;
      runLevel: RunLevelFinding | null;
      /** One line when the analytics document may still move underneath. */
      provisionalNote: string | null;
    };

export interface BuildStageFindingsInput {
  analytics: EvalStageAnalyticsV1 | null;
  summary: EvalRunDecisionSummary | null;
  diagnostics: readonly EvalRunDecisionDiagnostic[];
  scannedIterations: number;
  serverComplete: boolean;
  walkExhausted: boolean;
  /** The decision-summary read's own state, threaded verbatim. */
  status: "disabled" | "loading" | "ready" | "error";
  error: { title: string; detail: string } | null;
  /** Whether the run has reached a state that could have diagnostics. */
  runTerminal: boolean;
  /** Whether a trace can be opened from this surface at all. */
  canViewTrace: boolean;
}

export function buildStageFindings(
  input: BuildStageFindingsInput,
): StageFindingsState {
  if (input.status === "disabled") return { kind: "disabled" };
  if (!input.runTerminal) return { kind: "runNotTerminal" };
  if (input.status === "loading") return { kind: "loading" };
  if (input.status === "error") {
    // The copy discipline `FAILURE_COPY` uses on the decision card: name what
    // could not be read and what that means for what is on screen, and never
    // let it read as a finding about the server.
    return {
      kind: "unavailable",
      title: input.error?.title ?? "Couldn't load the trial evidence",
      detail:
        input.error?.detail ??
        "The read did not complete, so the trials behind these stage counts are not listed here.",
    };
  }
  const { analytics, summary } = input;
  if (!analytics || !summary) return { kind: "loading" };

  // IDENTITY FIRST. Two documents about two different runs would join
  // perfectly and mean nothing.
  if (analytics.runId !== summary.runId) return { kind: "identityMismatch" };

  // A legacy or verdict-less run has no D9 diagnostics to join — the contract
  // says so in the verdict source, and an empty list from one of those is an
  // absence of the contract rather than an absence of failures.
  if (summary.verdictSource !== "policyV2" && input.diagnostics.length === 0) {
    return { kind: "noDecisionDiagnostics" };
  }

  const overall = analytics.slices.find(
    (slice) => slice.slice.dimension === "overall",
  );
  const tallyByStage = new Map<UserValueStage, EvalStageTally>();
  for (const tally of overall?.stages ?? [])
    tallyByStage.set(tally.stage, tally);

  const byStage: Record<string, StageFindings | undefined> = {};
  const attributed = new Set<string>();
  const scopeLine = describeScanScope({
    scannedIterations: input.scannedIterations,
    serverComplete: input.serverComplete,
    walkExhausted: input.walkExhausted,
  });
  /**
   * BOTH signals, before any note claims a population.
   *
   * `serverComplete` is the server's claim that `items` is the whole
   * non-passing set; `walkExhausted` is this client's separate fact that every
   * offered cursor was followed. In production they cannot disagree in this
   * direction — the contract refuses a `complete` page that carries a
   * `nextCursor`, so a complete page one offers nothing to walk — but this
   * function is exported and pure, and the two notes below are claims about a
   * POPULATION. Requiring both is strictly more conservative and can never be
   * wrong; requiring one leans on an invariant a caller could fail to hold.
   */
  const completeScan = input.serverComplete && input.walkExhausted;

  for (const [stage, tally] of tallyByStage) {
    const trials: {
      trial: StageFindingTrial;
      reason: StageReason | null;
      nextAction: string;
    }[] = [];
    for (const diagnostic of input.diagnostics) {
      // The ONLY attribution rule: an unverified chain is not evidence, and a
      // row that is not `failed` is not a failure at this stage.
      if (diagnostic.chain.status !== "verified") continue;
      const row = diagnostic.chain.stages.find(
        (entry) => entry.stage === stage,
      );
      if (!row || row.state !== "failed") continue;
      attributed.add(diagnostic.iterationId);
      trials.push({
        // `?? null`, never `?? <some reason>`: an absent reason is a fact
        // about what the run recorded, and naming a cause here would be the
        // one thing this join exists not to do.
        reason: row.reason ?? null,
        nextAction: diagnostic.nextAction,
        trial: toFindingTrial(
          diagnostic,
          stage,
          analytics.runId,
          input.canViewTrace,
        ),
      });
    }
    if (trials.length === 0) {
      // A stage with a failing tally and no attributable trial still gets a
      // section, because the gap is itself the finding. A stage with neither
      // gets nothing.
      const note = unattributedNote(tally, 0, completeScan);
      if (note === null) continue;
      byStage[stage] = {
        stage,
        groups: [],
        headline: stageHeadline(stage, tally),
        scopeLine,
        unattributedNote: note,
        reconciliationNote: null,
      };
      continue;
    }

    const groups = groupByReason(trials);
    byStage[stage] = {
      stage,
      groups,
      headline: stageHeadline(stage, tally),
      scopeLine,
      unattributedNote: unattributedNote(tally, trials.length, completeScan),
      reconciliationNote: reconciliationNote(
        tally,
        trials.length,
        completeScan,
      ),
    };
  }

  // Everything D9 listed that no stage row accounts for. NEVER guessed onto a
  // stage: a setup abort and an evaluator error are real answers about a run
  // that never reached a stage, and the contract says so explicitly.
  const orphans = input.diagnostics.filter(
    (diagnostic) => !attributed.has(diagnostic.iterationId),
  );

  return {
    kind: "ready",
    byStage,
    runLevel:
      orphans.length > 0
        ? {
            count: orphans.length,
            line:
              `${orphans.length} non-passing ${
                orphans.length === 1 ? "trial is" : "trials are"
              } not attributable to a stage` +
              ` — a setup abort, an evaluator error, or no recorded chain.`,
          }
        : null,
    provisionalNote:
      analytics.materializationState === "provisional"
        ? "These stage counts are provisional — a judge pass is still landing, so they may change."
        : null,
  };
}

/**
 * The stage's own sentence, population first.
 *
 * "Response failed in 2 of 3 measured trials" — the denominator is `measured`,
 * not `applicable`, because a stage's failures are only ever counted over what
 * was actually decided. Naming the wrong denominator here would restate a
 * coverage problem as a quality one.
 */
function stageHeadline(stage: UserValueStage, tally: EvalStageTally): string {
  const label = USER_VALUE_STAGE_LABELS[stage];
  if (tally.measured === 0) {
    // Never "0 of 0 failed": no denominator means nothing was decided, which
    // is the one thing a percentage-shaped sentence cannot say.
    return `${label} was not measured on any trial in this run.`;
  }
  return `${label} failed in ${tally.failed} of ${tally.measured} measured ${
    tally.measured === 1 ? "trial" : "trials"
  }.`;
}

/**
 * The "these failures have no diagnostic row" line, or `null`.
 *
 * Only stated under a COMPLETE scan. On a partial page the gap is explained by
 * the paging — more trials have simply not been examined — and reporting it as
 * a population fact would invent a finding out of an unfinished read.
 */
function unattributedNote(
  tally: EvalStageTally,
  attributed: number,
  completeScan: boolean,
): string | null {
  if (!completeScan) return null;
  const gap = tally.failed - attributed;
  if (gap <= 0) return null;
  return (
    `${gap} further stage ${gap === 1 ? "failure" : "failures"} occurred on ` +
    `trials whose cases passed, so they have no diagnostic row here.`
  );
}

/**
 * The "these two counts disagree" line, or `null`.
 *
 * The opposite direction from {@link unattributedNote}: more attributed trials
 * than the tally counted. That cannot be explained by policy v2 and is worth
 * saying out loud — but it is never fixed by rewriting either number.
 */
function reconciliationNote(
  tally: EvalStageTally,
  attributed: number,
  completeScan: boolean,
): string | null {
  if (!completeScan) return null;
  if (attributed <= tally.failed) return null;
  return (
    `${attributed} trials are listed here while the run's own tally counts ` +
    `${tally.failed} failing at this stage. The tally is shown as recorded; ` +
    `this disagreement is worth reporting.`
  );
}

function toFindingTrial(
  diagnostic: EvalRunDecisionDiagnostic,
  stage: UserValueStage,
  /** The run ON SCREEN, which the evidence's own locator must match. */
  runId: string,
  canViewTrace: boolean,
): StageFindingTrial {
  const first = decisionDiagnosticFirstFailedStage(diagnostic);
  // The tool names are the finding at `selection` and `call`, and noise
  // everywhere else — a reader under a `connection` failure should not have to
  // rule out a tool name that has nothing to do with it.
  const toolsMatter = stage === "selection" || stage === "call";
  return {
    iterationId: diagnostic.iterationId,
    iterationNumber: diagnostic.iterationNumber,
    title: truncateUntrusted(diagnostic.title),
    // Authored elsewhere. React escapes it on render; this only bounds its
    // length so one pathological message cannot swamp the section.
    observedFailure: truncateUntrusted(diagnostic.observed?.failure),
    expectedTools: toolsMatter
      ? (diagnostic.expected?.toolNames ?? null)
      : null,
    observedTools: toolsMatter
      ? (diagnostic.observed?.toolNames ?? null)
      : null,
    // `first !== stage` means this stage is a LATER failure on a trial that
    // already broke earlier — a non-primary appearance.
    earlierStageAlsoFailed: first !== undefined && first !== stage,
    // The SAME three conditions the decision card's own row applies, from the
    // same helper. A second copy of the rule here is a second thing to keep in
    // step, and the one that offers a button that opens nothing.
    traceable: isDiagnosticTraceable(diagnostic, runId, canViewTrace),
    testCaseId: diagnostic.testCaseId ?? null,
    runId: diagnostic.evidence.runId,
  };
}

/**
 * Group a stage's trials by the reason its own chain row recorded.
 *
 * By `StageReason` deliberately: it is the SAME vocabulary D5c's `reasons[]`
 * tallies by, so a reader can cross-check a group's count against the tally
 * line directly above it. Grouping by failure category instead would have
 * produced buckets that look comparable to the tally and are not.
 *
 * Ordered count-descending, tie-broken by `STAGE_REASONS` order so the
 * ordering is stable across renders and matches the tally's own ordering.
 */
function groupByReason(
  entries: {
    trial: StageFindingTrial;
    reason: StageReason | null;
    nextAction: string;
  }[],
): StageFindingGroup[] {
  const buckets = new Map<
    StageReason | null,
    { trials: StageFindingTrial[]; actions: Set<string> }
  >();
  for (const entry of entries) {
    const bucket = buckets.get(entry.reason) ?? {
      trials: [],
      actions: new Set<string>(),
    };
    bucket.trials.push(entry.trial);
    bucket.actions.add(entry.nextAction);
    buckets.set(entry.reason, bucket);
  }
  return [...buckets.entries()]
    .map(([reason, bucket]) => ({
      reason,
      key: reason ?? "reasonNotRecorded",
      label:
        reason === null
          ? STAGE_REASON_NOT_RECORDED_LABEL
          : STAGE_REASON_LABELS[reason],
      count: bucket.trials.length,
      trials: bucket.trials,
      // One action only when the group AGREES on one. Two failure categories
      // under one reason is a real thing, and picking one would be a guess
      // dressed as the contract's own answer.
      nextAction: bucket.actions.size === 1 ? [...bucket.actions][0]! : null,
    }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      // The unexplained group sorts LAST within its count, not first: with no
      // reason there is nothing for a reader to act on, so it should not
      // outrank a group that names one. `indexOf` returns -1 for `null`, which
      // would have sorted it ahead of every named reason.
      return reasonRank(a.reason) - reasonRank(b.reason);
    });
}

function reasonRank(reason: StageReason | null): number {
  return reason === null ? STAGE_REASONS.length : STAGE_REASONS.indexOf(reason);
}
