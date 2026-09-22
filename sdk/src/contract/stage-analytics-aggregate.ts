/**
 * Turning trials into `EvalStageAnalyticsV1` — the reference aggregation.
 *
 * Browser-safe, no node-only deps, and PURE: no ctx, no network, no clock.
 * Every timestamp on the result is supplied by the caller, which is what makes
 * the golden fixtures in `./__tests__/` byte-stable and therefore usable as the
 * conformance target for the backend's hand-written mirror.
 *
 * ── Why this exists here, given the backend cannot import it ─────────────────
 *
 * Convex functions bundle independently and cannot import `@mcpjam/sdk` (the
 * same constraint `evalStageDerivation.ts` records). So the materializer that
 * actually writes the row is hand-written over there. This module is the
 * SPECIFICATION it is written against, and the fixtures it produces are how
 * "hand-written" is kept from meaning "different". A second implementation is
 * acceptable; a second, unpinned SEMANTICS is not.
 *
 * ── The four counting rules ──────────────────────────────────────────────────
 *
 * 1. **One trial, one vote, per slice.** A trial contributes to `overall`, to
 *    its intent slice, to its model slice and to its host slice — once each.
 *    Marginals, never a cross-product.
 * 2. **Excluded trials contribute no observations, only a reason.** They are
 *    counted in the coverage tallies and are absent from every numerator and
 *    every denominator. An excluded trial that leaked into a denominator is a
 *    silently shrinking rate.
 * 3. **Setup is counted per run+phase, impact per trial.** The signal is copied
 *    onto every iteration, so counting copies would report one connect attempt
 *    N times.
 * 4. **Nothing is inferred.** No verdict, no state, no reach is derived here —
 *    every one of them is read off a payload that a write boundary already
 *    verified. This module counts; it does not decide.
 */

import {
  FAILURE_CATEGORIES,
  USER_VALUE_STAGES,
  type FailureCategory,
  type IterationStatus,
  type UserValueStage,
} from "./chain.js";
import {
  STAGE_REASONS,
  type StageReason,
  type StageResultRow,
} from "./stage-derivation.js";
import {
  LATENCY_BASIS_EVIDENCE_SPAN_UNION,
  LATENCY_BASIS_SETUP_PHASE_WALL,
  LATENCY_UNIT,
  STAGE_MEASUREMENTS_SCHEMA_VERSION,
  reachIsConsistentWithState,
  type StageMeasurementsV1,
  type StageReach,
} from "./stage-measurements.js";
import { normalizeIntent } from "./stage-intent.js";
import {
  EVAL_STAGE_ANALYTICS_SCHEMA_VERSION,
  MAX_HOST_SLICES,
  MAX_INTENT_SLICES,
  MAX_MODEL_SLICES,
  SETUP_PHASES,
  isServerAttributedSetupFailure,
  type EvalStageAnalyticsMaterializationState,
  type EvalStageAnalyticsSlice,
  type EvalStageAnalyticsSliceRow,
  type EvalStageAnalyticsV1,
  type EvalStageCoverageDetail,
  type EvalStageExclusionClass,
  type EvalStageExclusions,
  type EvalStageLatencyAggregate,
  type EvalStageTally,
  type EvalSetupTally,
  type SetupPhase,
} from "./stage-analytics.js";

// ── inputs ───────────────────────────────────────────────────────────────────

/**
 * One trial, as the materializer reads it out of storage.
 *
 * Everything here is a FACT already written and already verified. In particular
 * `chainVerified` and `measurementsVerified` are the SERVER's integrity
 * verdicts, read from server-owned metadata keys — not something a client
 * asserted about itself, and not something this module re-derives.
 */
export type StageAnalyticsTrialInput = {
  /** Distinct trial identity (the iteration id). Used for impact de-duplication. */
  trialKey: string;
  /** The iteration lifecycle, verbatim. */
  status: IterationStatus | string;
  /** The verified chain, if this trial has one. */
  stageResults?: readonly StageResultRow[];
  /** The analyzer version the chain was derived at. */
  stageAnalyzerVersion?: number;
  /** The trial's failure bucket. May be present with NO failed stage. */
  failureCategory?: FailureCategory;
  /** The server's integrity verdict on the chain. `false` means do not believe it. */
  chainVerified?: boolean;
  /** The trial's measurements, if it has them. */
  measurements?: StageMeasurementsV1;
  /** The server's integrity verdict on the measurements. */
  measurementsVerified?: boolean;
  /** The evaluator itself errored. Excluded, and never as a server failure. */
  evaluatorErrored?: boolean;

  // -- slice attribution --
  /** Frozen at run start. `null`/absent is UNLABELLED, never `general`. */
  intent?: string | null;
  provider?: string;
  model?: string;
  hostKey?: string;
  hostName?: string;
  /** `emulated` | `harness:<id>`. Absent means NOT RECORDED. */
  executionEngine?: string;
};

/**
 * One setup signal as read off ONE iteration.
 *
 * The caller passes every copy it saw — de-duplication is this module's job,
 * precisely so that no call site has to remember it is the one thing here that
 * must not be counted per trial.
 */
export type StageAnalyticsSetupSignalInput = {
  phase: SetupPhase;
  outcome: "ok" | "failed";
  attribution?: "ours" | "theirs" | "unknown";
  egressVerified?: boolean;
  /** The phase's wall-clock envelope. One sample per ATTEMPT, not per copy. */
  durationMs?: number;
  /** The trial this copy was read from. Counted distinctly. */
  trialKey?: string;
};

export type StageAnalyticsRunInput = {
  runId: string;
  suiteId: string;
  runGroupId?: string;
  /** The run's frozen authored-config revision. Absent blocks parity. */
  configRevision?: string;
  /** Digest over the comparable case set this run measured. Absent blocks parity. */
  caseSetFingerprint?: string;
  organizationId?: string;
  workspaceId?: string;
  projectId?: string;
  /** Epoch ms. */
  runCompletedAt?: number;
  /** Newest update stamp among the source iterations. The staleness handle. */
  sourceMaxUpdatedAt?: number;
  /**
   * `provisional` while any applicable judge fanout is still pending.
   *
   * Supplied rather than inferred: only the caller can see the run row's fanout
   * columns, and guessing `final` because the trials look complete is exactly
   * how a summary gets frozen one judge pass early.
   */
  materializationState: EvalStageAnalyticsMaterializationState;
  /** Epoch ms. Supplied so this function stays pure and its fixtures stable. */
  now: number;
  /** Preserved from the existing row on a rebuild, so `createdAt` is stable. */
  createdAt?: number;
  /** The analyzer version THIS reader understands. Anything higher is excluded. */
  readerStageAnalyzerVersion: number;
  /** The measurement schema version THIS reader understands. */
  readerMeasurementsSchemaVersion?: number;
};

export type StageAnalyticsInput = {
  run: StageAnalyticsRunInput;
  trials: readonly StageAnalyticsTrialInput[];
  setupSignals?: readonly StageAnalyticsSetupSignalInput[];
};

// ── classification ───────────────────────────────────────────────────────────

/** Terminal statuses that produce a comparable observation. */
const INCLUDABLE_STATUSES = new Set<string>(["completed", "failed"]);

/** Lifecycle statuses and the coverage-detail key each maps to. */
const LIFECYCLE_DETAIL_KEY: Record<string, keyof EvalStageCoverageDetail> = {
  pending: "notTerminal",
  running: "notTerminal",
  skipped: "skipped",
  cancelled: "cancelled",
  setup_failed: "setupFailed",
  timed_out: "timedOut",
};

export type TrialClassification = {
  /** Absent means the trial is INCLUDED. */
  class?: EvalStageExclusionClass;
  /** The precise reason, for the run-level detail tally. */
  detail?: keyof EvalStageCoverageDetail;
};

/**
 * Decide whether one trial contributes observations, and if not, why.
 *
 * Order matters and is deliberate: **lifecycle, then version, then integrity.**
 *
 *   - Lifecycle first because a cancelled trial's missing chain is not an
 *     integrity problem; reporting it as one would fill the integrity tally
 *     with runs somebody stopped on purpose.
 *   - Version before integrity because a version-ahead payload is EXPECTED
 *     during a deploy and is not a defect, while `chainUnverified` is. A
 *     version-ahead chain also cannot be meaningfully integrity-checked by a
 *     reader that does not know what its words mean.
 *
 * Nothing here is ever coerced. A version-ahead or invalid payload is excluded
 * and counted — never downgraded, never partially read, and never treated as a
 * passing observation. "We could not read this" and "this was fine" are the two
 * claims this entire contract exists to keep apart.
 */
export function classifyStageAnalyticsTrial(
  trial: StageAnalyticsTrialInput,
  readerStageAnalyzerVersion: number,
  readerMeasurementsSchemaVersion: number
): TrialClassification {
  if (trial.evaluatorErrored === true) {
    return { class: "lifecycle", detail: "evaluatorError" };
  }
  if (!INCLUDABLE_STATUSES.has(trial.status)) {
    return {
      class: "lifecycle",
      detail: LIFECYCLE_DETAIL_KEY[trial.status] ?? "executionFailed",
    };
  }

  // Resolved from the chain's stamp, falling back to the measurements' own.
  // A trial that carries only the latter is still a trial derived at that
  // analyzer: reading just the top-level field would let a NEWER-source trial
  // through the version gate and then stamp the row with the reader's version,
  // which is the false-parity hole this whole check exists to close.
  const observedAnalyzerVersion =
    trial.stageAnalyzerVersion ?? trial.measurements?.stageAnalyzerVersion;
  if (
    observedAnalyzerVersion !== undefined &&
    observedAnalyzerVersion > readerStageAnalyzerVersion
  ) {
    return { class: "version", detail: "chainVersionAhead" };
  }
  if (
    trial.measurements !== undefined &&
    trial.measurements.schemaVersion > readerMeasurementsSchemaVersion
  ) {
    return { class: "version", detail: "measurementsVersionAhead" };
  }

  if (trial.stageResults === undefined || trial.stageResults.length === 0) {
    return { class: "integrity", detail: "chainMissing" };
  }
  if (trial.chainVerified !== true) {
    // Absent is NOT verified. A run from before the check shipped carries no
    // verdict, and "we never checked" must not read as "it checked out".
    return { class: "integrity", detail: "chainUnverified" };
  }
  if (trial.measurements === undefined) {
    return { class: "integrity", detail: "measurementsMissing" };
  }
  if (trial.measurementsVerified !== true) {
    return { class: "integrity", detail: "measurementsInvalid" };
  }
  if (
    trial.stageAnalyzerVersion !== undefined &&
    trial.measurements.stageAnalyzerVersion !== trial.stageAnalyzerVersion
  ) {
    // The chain and its own measurements name different analyzers. Always a
    // bug, never a deploy window — see the detail schema's docblock.
    return { class: "integrity", detail: "analyzerMismatch" };
  }
  return {};
}

// ── accumulators ─────────────────────────────────────────────────────────────

type LatencyAcc = {
  sampleCount: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
};

type StageAcc = {
  applicable: number;
  reached: number;
  notReached: number;
  reachUnknown: number;
  measured: number;
  passed: number;
  failed: number;
  notMeasured: number;
  notApplicable: number;
  excluded: Map<EvalStageExclusionClass, number>;
  reasons: Map<StageReason, number>;
  latency?: LatencyAcc;
};

type SliceAcc = {
  slice: EvalStageAnalyticsSlice;
  /** Canonical sort key, so ordering never depends on insertion order. */
  sortKey: string;
  includedTrials: number;
  excluded: Map<EvalStageExclusionClass, number>;
  failureCategories: Map<FailureCategory, number>;
  stages: StageAcc[];
};

/**
 * The sort key an UNLABELLED intent slice gets.
 *
 * `U+FFFF` is a noncharacter: it sorts above every code point an authored
 * intent may legally contain, so "Unlabeled" lands last with no special case in
 * the comparator and no chance of colliding with a real label.
 */
const UNLABELED_SORT_KEY = "\uFFFF";

function emptyStageAcc(): StageAcc {
  return {
    applicable: 0,
    reached: 0,
    notReached: 0,
    reachUnknown: 0,
    measured: 0,
    passed: 0,
    failed: 0,
    notMeasured: 0,
    notApplicable: 0,
    excluded: new Map(),
    reasons: new Map(),
  };
}

function bump<K>(map: Map<K, number>, key: K, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

function observeLatency(acc: StageAcc, value: number): void {
  if (!Number.isFinite(value) || value < 0) return;
  if (acc.latency === undefined) {
    acc.latency = {
      sampleCount: 1,
      totalMs: value,
      minMs: value,
      maxMs: value,
    };
    return;
  }
  acc.latency.sampleCount += 1;
  acc.latency.totalMs += value;
  if (value < acc.latency.minMs) acc.latency.minMs = value;
  if (value > acc.latency.maxMs) acc.latency.maxMs = value;
}

/** A count map into the closed, omit-zero exclusions object. */
function toExclusions(
  map: Map<EvalStageExclusionClass, number>
): EvalStageExclusions {
  const out: EvalStageExclusions = {};
  for (const [key, count] of map) {
    if (count > 0) out[key] = count;
  }
  return out;
}

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * What version to stamp a row with, and whether it is mixed.
 *
 * `stamp` is the single observed version when the included trials agree, the
 * NEWEST when they do not, and the reader's own when nothing was included (a
 * row with zero observations makes no semantic claim, so there is no source
 * version to report).
 *
 * `mixed` is the full ascending list, present ONLY when more than one version
 * contributed. Parity refuses any row carrying it, so no comparison ever rests
 * on `stamp` alone in the ambiguous case.
 */
function resolveSourceVersions(
  observed: ReadonlySet<number>,
  readerVersion: number
): { stamp: number; mixed?: number[] } {
  const versions = [...observed].sort((a, b) => a - b);
  const newest = versions[versions.length - 1];
  if (newest === undefined) return { stamp: readerVersion };
  if (versions.length === 1) return { stamp: newest };
  return { stamp: newest, mixed: versions };
}

// ── the aggregation ──────────────────────────────────────────────────────────

/**
 * Build one run's stage analytics from its trials.
 *
 * Deterministic: the same trials in any order produce the same row, because
 * every array is emitted in a canonical order rather than in insertion order.
 * That is what makes a rebuild after a judge fanout comparable to the row it
 * replaces — an aggregation whose output depended on read order would appear to
 * change on every rebuild whether or not anything actually moved.
 */
export function aggregateStageAnalytics(
  input: StageAnalyticsInput
): EvalStageAnalyticsV1 {
  const { run } = input;
  const readerMeasurementsVersion =
    run.readerMeasurementsSchemaVersion ?? STAGE_MEASUREMENTS_SCHEMA_VERSION;

  const slices = new Map<string, SliceAcc>();
  const detail = new Map<keyof EvalStageCoverageDetail, number>();
  const runExcluded = new Map<EvalStageExclusionClass, number>();
  // The versions that ACTUALLY produced the included observations. A trial
  // derived at an older analyzer is included — excluding it would discard
  // nearly all history the first time the version bumps — so the row has to
  // report what produced it rather than what this reader understands.
  const sourceAnalyzerVersions = new Set<number>();
  const sourceMeasurementsVersions = new Set<number>();

  let includedTrials = 0;

  function sliceFor(
    key: string,
    slice: EvalStageAnalyticsSlice,
    sortKey: string
  ): SliceAcc {
    let acc = slices.get(key);
    if (acc === undefined) {
      acc = {
        slice,
        sortKey,
        includedTrials: 0,
        excluded: new Map(),
        failureCategories: new Map(),
        stages: USER_VALUE_STAGES.map(() => emptyStageAcc()),
      };
      slices.set(key, acc);
    }
    return acc;
  }

  /**
   * The `overall` slice exists from the start, before any trial is seen.
   *
   * Every other slice is created lazily by the trial that needs it, which is
   * correct for dimension values — no trials means no models and no hosts to
   * name, and inventing an "unknown" row would invite a comparison against it.
   * `overall` is NOT a dimension value though: it is the one slice every reader
   * is promised, and the schema requires exactly one of it.
   *
   * Created eagerly because a run with ZERO includable trials is a real and
   * ordinary outcome — a run cancelled before its first iteration existed, or
   * one whose every case was filtered or disabled. Left lazy, such a run
   * produced `slices: []` and a row that failed this contract's own validator,
   * turning an honest "nothing to measure" into an integrity failure at the
   * write boundary. An empty overall funnel is the correct answer: zero
   * everywhere, and every rate `notMeasured`.
   */
  sliceFor("overall", { dimension: "overall" }, "");

  /**
   * Which slices one trial belongs to.
   *
   * A dimension whose value the trial does not carry produces NO slice for that
   * dimension — except intent, where absence is itself a slice (`null`,
   * unlabelled). Model and host are different: a trial with no recorded model
   * cannot be attributed to one, and inventing an "unknown model" row would
   * invite a comparison against it.
   */
  function slicesForTrial(trial: StageAnalyticsTrialInput): SliceAcc[] {
    const out: SliceAcc[] = [sliceFor("overall", { dimension: "overall" }, "")];

    const intent = normalizeIntent(trial.intent ?? undefined) ?? null;
    out.push(
      sliceFor(
        `intent:${intent ?? ""}`,
        { dimension: "intent", intent },
        intent === null ? UNLABELED_SORT_KEY : intent
      )
    );

    if (trial.provider !== undefined && trial.model !== undefined) {
      // JSON-encoded rather than joined by a delimiter, because ANY delimiter
      // can appear inside a provider or model name: `("a b", "c")` and
      // `("a", "b c")` both join to `"a b c"`, silently merging two distinct
      // model slices into one whose counts belong to neither. The encoding is
      // also the sort key, so ordering stays deterministic and still reads
      // provider-then-model.
      const key = JSON.stringify([trial.provider, trial.model]);
      out.push(
        sliceFor(
          `model:${key}`,
          { dimension: "model", provider: trial.provider, model: trial.model },
          key
        )
      );
    }

    if (trial.hostKey !== undefined) {
      out.push(
        sliceFor(
          `host:${trial.hostKey}`,
          {
            dimension: "host",
            hostKey: trial.hostKey,
            ...(trial.hostName !== undefined
              ? { hostName: trial.hostName }
              : {}),
            ...(trial.executionEngine !== undefined
              ? { executionEngine: trial.executionEngine }
              : {}),
          },
          trial.hostKey
        )
      );
    }
    return out;
  }

  for (const trial of input.trials) {
    const verdict = classifyStageAnalyticsTrial(
      trial,
      run.readerStageAnalyzerVersion,
      readerMeasurementsVersion
    );
    const targets = slicesForTrial(trial);

    if (verdict.class !== undefined) {
      bump(runExcluded, verdict.class);
      if (verdict.detail !== undefined) bump(detail, verdict.detail);
      for (const acc of targets) bump(acc.excluded, verdict.class);
      // Rule 2: an excluded trial contributes a reason and nothing else. It
      // touches no stage tally, so it can never reach a numerator or a
      // denominator.
      continue;
    }

    includedTrials += 1;
    // Same resolution as the version gate above — a trial stamped only on its
    // measurements still contributes its analyzer version, or the row would
    // report a source set it did not actually aggregate.
    const observedAnalyzerVersion =
      trial.stageAnalyzerVersion ?? trial.measurements?.stageAnalyzerVersion;
    if (observedAnalyzerVersion !== undefined) {
      sourceAnalyzerVersions.add(observedAnalyzerVersion);
    }
    if (trial.measurements !== undefined) {
      sourceMeasurementsVersions.add(trial.measurements.schemaVersion);
    }
    for (const acc of targets) {
      acc.includedTrials += 1;
      if (trial.failureCategory !== undefined) {
        bump(acc.failureCategories, trial.failureCategory);
      }
    }

    const decided = trial.stageResults ?? [];
    const measurementRows = trial.measurements?.rows ?? [];

    USER_VALUE_STAGES.forEach((stage, index) => {
      const row = decided[index];
      if (row === undefined || row.stage !== stage) return;
      const measuredRow = measurementRows[index];
      // Reach comes from the measurements when they agree with the state, and
      // falls back to what the state implies otherwise. It is never taken from
      // a measurement row that contradicts its own chain.
      const agrees =
        measuredRow !== undefined &&
        measuredRow.stage === stage &&
        reachIsConsistentWithState(row.state, measuredRow.reach);
      const reach: StageReach = agrees
        ? measuredRow.reach
        : row.state === "passed" || row.state === "failed"
        ? "reached"
        : row.state === "notReached"
        ? "notReached"
        : row.state === "notApplicable"
        ? "notApplicable"
        : "unknown";

      for (const acc of targets) {
        const tally = acc.stages[index];
        if (tally === undefined) continue;
        if (row.reason !== undefined) bump(tally.reasons, row.reason);

        if (row.state === "notApplicable") {
          tally.notApplicable += 1;
          bump(tally.excluded, "notApplicable");
          continue;
        }
        tally.applicable += 1;

        if (reach === "notReached") {
          tally.notReached += 1;
          continue;
        }
        if (reach !== "reached") {
          // `unknown`, or a `notApplicable` reach on an applicable stage — a
          // contradiction the agreement check already rejects. Either way it is
          // never counted as an observation.
          tally.reachUnknown += 1;
          bump(tally.excluded, "reachUnknown");
          continue;
        }

        tally.reached += 1;
        if (row.state === "passed") {
          tally.measured += 1;
          tally.passed += 1;
        } else if (row.state === "failed") {
          tally.measured += 1;
          tally.failed += 1;
        } else {
          // Reached, but nothing decided it. THE measurement-coverage gap.
          tally.notMeasured += 1;
          bump(tally.excluded, "notMeasured");
        }

        // `agrees` is required, not just a non-empty latency: when it is false
        // the row at this index describes a DIFFERENT stage (a misordered
        // payload) or contradicts its own chain. Reach already falls back to
        // `row.state` in that case; reading latency off the same row anyway
        // would attribute one stage's duration to another, which is worse than
        // having no sample — a wrong number is indistinguishable from a right
        // one once it is summed into an aggregate.
        if (
          agrees &&
          measuredRow?.latency !== undefined &&
          measuredRow.latency.basis === LATENCY_BASIS_EVIDENCE_SPAN_UNION
        ) {
          observeLatency(tally, measuredRow.latency.value);
        }
      }
    });
  }

  // ── setup: one attempt per run+phase, impact per trial ────────────────────
  //
  // The caller passes EVERY per-iteration copy of a run+phase signal, and the
  // copies are expected identical because they are literally copies. When they
  // are not, first-seen-wins would make the reported outcome, attribution and
  // duration depend on read order — an `ok` copy followed by a `failed` one
  // reporting `failedAttempts: 0` beside `impactedTrials: 1`, which is not just
  // order-dependent but self-contradictory, and reversing the order changes the
  // answer. So conflicting copies are RECONCILED by rules that do not depend on
  // order and do not invent a fact:
  //
  //   - the attempt FAILED if any copy saw it fail (failure is the observation
  //     that matters, and `impactedTrials` is already counted from the failed
  //     copies, so this is what keeps the two consistent);
  //   - attribution and the egress canary are read only from the FAILED copies,
  //     and only when those agree — a disagreement is `unknown`, which is not
  //     server-attributable;
  //   - latency is a sample only when every copy reporting a duration reports
  //     the SAME one. Otherwise no sample, the same rule every other timing in
  //     this contract follows: a wrong number is worse than a missing one.
  const setupByPhase = new Map<
    SetupPhase,
    {
      copies: StageAnalyticsSetupSignalInput[];
      impacted: Set<string>;
    }
  >();
  for (const signal of input.setupSignals ?? []) {
    if (!(SETUP_PHASES as readonly string[]).includes(signal.phase)) continue;
    let entry = setupByPhase.get(signal.phase);
    if (entry === undefined) {
      entry = { copies: [], impacted: new Set() };
      setupByPhase.set(signal.phase, entry);
    }
    entry.copies.push(signal);
    // Impact, unlike the attempt, IS per trial — this union is the whole reason
    // N copies must yield N impacted trials and one attempt.
    if (signal.outcome === "failed" && signal.trialKey !== undefined) {
      entry.impacted.add(signal.trialKey);
    }
  }

  /** The one value every entry agrees on, or `undefined` if they do not. */
  function agreedValue<T>(values: readonly T[]): T | undefined {
    const [first, ...rest] = values;
    if (first === undefined) return undefined;
    return rest.every((value) => value === first) ? first : undefined;
  }

  const setup: EvalSetupTally[] = SETUP_PHASES.flatMap((phase) => {
    const entry = setupByPhase.get(phase);
    if (entry === undefined) return [];
    const { copies, impacted } = entry;

    const failedCopies = copies.filter((copy) => copy.outcome === "failed");
    const failed = failedCopies.length > 0;

    // Only the failed copies can attribute a failure, and only unanimously.
    const attribution = failed
      ? agreedValue(failedCopies.map((copy) => copy.attribution))
      : undefined;
    const egressVerified = failed
      ? agreedValue(failedCopies.map((copy) => copy.egressVerified))
      : undefined;

    const durations = copies
      .map((copy) => copy.durationMs)
      .filter(
        (value): value is number =>
          typeof value === "number" && Number.isFinite(value) && value >= 0
      );
    const duration = durations.length > 0 ? agreedValue(durations) : undefined;

    return [
      {
        phase,
        uniqueAttempts: 1,
        failedAttempts: failed ? 1 : 0,
        serverAttributedFailures: isServerAttributedSetupFailure({
          outcome: failed ? "failed" : "ok",
          attribution,
          egressVerified,
        })
          ? 1
          : 0,
        impactedTrials: impacted.size,
        ...(duration !== undefined
          ? {
              latency: {
                unit: LATENCY_UNIT,
                basis: LATENCY_BASIS_SETUP_PHASE_WALL,
                sampleCount: 1,
                totalMs: duration,
                minMs: duration,
                maxMs: duration,
              },
            }
          : {}),
      },
    ];
  });

  // ── finalize ──────────────────────────────────────────────────────────────
  const finalizeStage = (
    stage: UserValueStage,
    acc: StageAcc
  ): EvalStageTally => ({
    stage,
    applicable: acc.applicable,
    reached: acc.reached,
    notReached: acc.notReached,
    reachUnknown: acc.reachUnknown,
    measured: acc.measured,
    passed: acc.passed,
    failed: acc.failed,
    notMeasured: acc.notMeasured,
    notApplicable: acc.notApplicable,
    excluded: toExclusions(acc.excluded),
    // Ordered by the REASON VOCABULARY, not by count: a chart whose rows
    // reorder themselves as counts shift is unreadable across two runs.
    reasons: STAGE_REASONS.flatMap((reason) => {
      const count = acc.reasons.get(reason) ?? 0;
      return count > 0 ? [{ reason, count }] : [];
    }),
    ...(acc.latency !== undefined
      ? {
          latency: {
            unit: LATENCY_UNIT,
            basis: LATENCY_BASIS_EVIDENCE_SPAN_UNION,
            ...acc.latency,
          } satisfies EvalStageLatencyAggregate,
        }
      : {}),
  });

  const finalizeSlice = (acc: SliceAcc): EvalStageAnalyticsSliceRow => ({
    slice: acc.slice,
    includedTrials: acc.includedTrials,
    excludedTrials: toExclusions(acc.excluded),
    failureCategories: FAILURE_CATEGORIES.flatMap((category) => {
      const count = acc.failureCategories.get(category) ?? 0;
      return count > 0 ? [{ category, count }] : [];
    }),
    stages: USER_VALUE_STAGES.map((stage, index) =>
      finalizeStage(stage, acc.stages[index] ?? emptyStageAcc())
    ),
  });

  const all = [...slices.values()];
  const dimensionCaps: Record<"intent" | "model" | "host", number> = {
    intent: MAX_INTENT_SLICES,
    model: MAX_MODEL_SLICES,
    host: MAX_HOST_SLICES,
  };

  const sliceTruncation: NonNullable<EvalStageAnalyticsV1["sliceTruncation"]> =
    [];
  const kept: SliceAcc[] = all.filter((s) => s.slice.dimension === "overall");

  for (const dimension of ["intent", "model", "host"] as const) {
    const members = all.filter((s) => s.slice.dimension === dimension);
    if (members.length === 0) continue;
    // Retain the LARGEST slices — a comparison over dimension values that
    // barely occurred is not the one anyone came for — with the canonical sort
    // key as the tie-break, so retention is deterministic rather than
    // read-order dependent.
    const ranked = [...members].sort(
      (a, b) =>
        b.includedTrials - a.includedTrials || compareKeys(a.sortKey, b.sortKey)
    );
    const retained = ranked.slice(0, dimensionCaps[dimension]);
    if (retained.length < members.length) {
      sliceTruncation.push({
        dimension,
        distinctValues: members.length,
        retained: retained.length,
      });
    }
    // Emit in CANONICAL order regardless of how retention ranked them.
    retained.sort((a, b) => compareKeys(a.sortKey, b.sortKey));
    kept.push(...retained);
  }

  const analyzerVersions = resolveSourceVersions(
    sourceAnalyzerVersions,
    run.readerStageAnalyzerVersion
  );
  const measurementsVersions = resolveSourceVersions(
    sourceMeasurementsVersions,
    readerMeasurementsVersion
  );

  return {
    schemaVersion: EVAL_STAGE_ANALYTICS_SCHEMA_VERSION,
    measurementUnit: "trial",
    runId: run.runId,
    suiteId: run.suiteId,
    ...(run.runGroupId !== undefined ? { runGroupId: run.runGroupId } : {}),
    ...(run.configRevision !== undefined
      ? { configRevision: run.configRevision }
      : {}),
    ...(run.caseSetFingerprint !== undefined
      ? { caseSetFingerprint: run.caseSetFingerprint }
      : {}),
    ...(run.organizationId !== undefined
      ? { organizationId: run.organizationId }
      : {}),
    ...(run.workspaceId !== undefined ? { workspaceId: run.workspaceId } : {}),
    ...(run.projectId !== undefined ? { projectId: run.projectId } : {}),
    ...(run.runCompletedAt !== undefined
      ? { runCompletedAt: run.runCompletedAt }
      : {}),
    sourceIterationCount: input.trials.length,
    ...(run.sourceMaxUpdatedAt !== undefined
      ? { sourceMaxUpdatedAt: run.sourceMaxUpdatedAt }
      : {}),
    stageAnalyzerVersion: analyzerVersions.stamp,
    ...(analyzerVersions.mixed !== undefined
      ? { sourceStageAnalyzerVersions: analyzerVersions.mixed }
      : {}),
    measurementsSchemaVersion: measurementsVersions.stamp,
    ...(measurementsVersions.mixed !== undefined
      ? { sourceMeasurementsSchemaVersions: measurementsVersions.mixed }
      : {}),
    materializationState: run.materializationState,
    createdAt: run.createdAt ?? run.now,
    updatedAt: run.now,
    includedTrials,
    excludedTrials: toExclusions(runExcluded),
    totalTrials: input.trials.length,
    excludedTrialDetail: Object.fromEntries(
      [...detail.entries()].filter(([, count]) => count > 0)
    ) as EvalStageCoverageDetail,
    slices: kept.map(finalizeSlice),
    setup,
    ...(sliceTruncation.length > 0 ? { sliceTruncation } : {}),
  };
}
