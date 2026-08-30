/**
 * The presentation model for the stage-analytics panel (D5c).
 *
 * PURE — no React, no fetching, no clock. Everything the panel renders is
 * derived here so the honest-state rules are unit-testable without a DOM, the
 * same split `suite-detail-model.ts` uses.
 *
 * ── The one rule this module exists to hold ──────────────────────────────────
 *
 * Every rate comes from the contract's own helpers (`measuredPassRate`,
 * `measurementCoverageRate`, `reachRate`, `latencyMeanMs`). There is no
 * division anywhere in this file, and there must never be one: the helpers are
 * what make `0/0` a `notMeasured` state rather than a `0%`, and a hand-rolled
 * `passed / measured` here would reintroduce exactly the number this whole
 * contract was built to make unrepresentable.
 *
 * A GENUINE measured zero is different and IS shown: `0/5` eligible renders
 * `0%`, because that is a real finding. Only a zero DENOMINATOR renders words.
 */
import {
  UNLABELED_INTENT_LABEL,
  USER_VALUE_STAGE_LABELS,
  latencyMeanMs,
  measuredPassRate,
  measurementCoverageRate,
  reachRate,
  type EvalSetupTally,
  type EvalStageAnalyticsSliceRow,
  type EvalStageAnalyticsV1,
  type EvalStageExclusions,
  type EvalStageRate,
  type EvalStageTally,
} from "@mcpjam/sdk/contract";
import type { StageAnalyticsFailureKind } from "@/lib/apis/eval-stage-analytics-api";

// ── panel state ──────────────────────────────────────────────────────────────
/**
 * What the panel is showing, as five mutually exclusive facts.
 *
 * `unsupported` and `unmeasuredLegacy` are deliberately NOT `empty`. "The
 * backend could not answer", "these runs finished before we measured this" and
 * "this suite has no runs" are three different things to know, and the one
 * thing none of them may look like is a funnel of zeros.
 */
export type StageAnalyticsPanelState =
  /** The read did not complete, or this deployment does not serve the route. */
  | { kind: "unsupported"; message: string }
  /** The route answered badly, or answered about something else. */
  | { kind: "error"; message: string }
  /** No runs at all yet — there is nothing to have measured. */
  | { kind: "empty" }
  /** The suite HAS runs, and none of them carries a document. Not a zero. */
  | { kind: "unmeasuredLegacy"; runCount: number }
  | { kind: "loading" }
  | { kind: "ready"; rows: EvalStageAnalyticsV1[] };

export function deriveStageAnalyticsPanelState(input: {
  status: "idle" | "loading" | "ready" | "error";
  rows: EvalStageAnalyticsV1[];
  error: { message: string; kind: StageAnalyticsFailureKind } | null;
  /** Whether the suite has runs at all — the legacy/empty distinction. */
  runCount: number;
  runsLoading: boolean;
}): StageAnalyticsPanelState {
  if (input.status === "error" && input.error) {
    // A service failure and a contract failure are both visible states, and
    // neither is an empty chart. They are split because only one of them is
    // actionable by the reader: "try again later" versus "this is a bug".
    if (
      input.error.kind === "routeUnavailable" ||
      input.error.kind === "requestFailed"
    ) {
      return { kind: "unsupported", message: input.error.message };
    }
    return { kind: "error", message: input.error.message };
  }
  if (input.status === "idle" || input.status === "loading") {
    return { kind: "loading" };
  }
  if (input.rows.length > 0) return { kind: "ready", rows: input.rows };
  // Zero rows is ambiguous on its own, and the run list is what disambiguates
  // it. Hold the loading frame rather than guessing while runs are still
  // arriving — guessing here would flash "no runs yet" at a suite that has
  // hundreds.
  if (input.runsLoading) return { kind: "loading" };
  if (input.runCount > 0) {
    return { kind: "unmeasuredLegacy", runCount: input.runCount };
  }
  return { kind: "empty" };
}

// ── rate formatting ──────────────────────────────────────────────────────────
/** The words a zero denominator renders as. Never a percentage. */
export const NOT_MEASURED_LABEL = "not measured";

export interface StageRateView {
  label: string;
  /** `72%`, or `null` when there is nothing to divide. */
  percent: string | null;
  /** `4/5` — the arithmetic, which always travels with the rate. */
  arithmetic: string | null;
  /** `0..1`, for a bar width. `null` means DRAW NO BAR. */
  fraction: number | null;
  /** Named exclusions, already in words. Empty when nothing was excluded. */
  exclusions: string[];
}

function formatRate(label: string, rate: EvalStageRate): StageRateView {
  if (rate.state === "notMeasured") {
    return {
      label,
      percent: null,
      arithmetic: null,
      fraction: null,
      exclusions: describeExclusions(rate.exclusions),
    };
  }
  return {
    label,
    // Rounded for display only; the arithmetic beside it is the exact claim.
    // A genuine measured zero formats as "0%" — that is a finding, not the
    // zero-denominator case the words exist for.
    percent: `${Math.round(rate.value * 100)}%`,
    arithmetic: `${rate.numerator}/${rate.denominator}`,
    fraction: rate.value,
    exclusions: describeExclusions(rate.exclusions),
  };
}

/** The six exclusion classes, in words a reader can act on. */
export const EXCLUSION_CLASS_LABELS: Record<keyof EvalStageExclusions, string> =
  {
    lifecycle: "never produced a comparable observation",
    integrity: "evidence missing or unverified",
    version: "produced by a version this reader does not understand",
    notApplicable: "does not apply to this case",
    reachUnknown: "nothing captured, so reach is undecidable",
    notMeasured: "reached, but nothing decided it",
  };

export function describeExclusions(exclusions: EvalStageExclusions): string[] {
  const out: string[] = [];
  for (const [key, label] of Object.entries(EXCLUSION_CLASS_LABELS) as [
    keyof EvalStageExclusions,
    string,
  ][]) {
    const count = exclusions[key];
    // Zero is OMITTED by the contract, so an undefined and a 0 mean the same
    // thing and neither is worth a line.
    if (count !== undefined && count > 0) out.push(`${count} ${label}`);
  }
  return out;
}

// ── per-stage rows ───────────────────────────────────────────────────────────
export interface StageRowView {
  stage: EvalStageTally["stage"];
  label: string;
  /** Of the trials whose reach we could decide, how many got here. */
  reach: StageRateView;
  /** Of the trials that reached, how many we actually decided. */
  coverage: StageRateView;
  /** Of what we decided, how much passed. */
  pass: StageRateView;
  applicable: number;
  notApplicable: number;
  reachUnknown: number;
  /** `123 ms · evidence span union`, or `null` when there are no samples. */
  latency: string | null;
  reasons: { reason: string; count: number }[];
}

export function toStageRowView(tally: EvalStageTally): StageRowView {
  return {
    stage: tally.stage,
    label: USER_VALUE_STAGE_LABELS[tally.stage],
    // The three rates, in the order they qualify one another: a 100% pass rate
    // over 5% coverage is not a green server, it is an uninstrumented one.
    reach: formatRate("Reach", reachRate(tally)),
    coverage: formatRate(
      "Measurement coverage",
      measurementCoverageRate(tally),
    ),
    pass: formatRate("Measured pass", measuredPassRate(tally)),
    applicable: tally.applicable,
    notApplicable: tally.notApplicable,
    reachUnknown: tally.reachUnknown,
    latency: formatLatency(tally.latency),
    reasons: tally.reasons.map((entry) => ({ ...entry })),
  };
}

/** The two bases, in words. Always shown — a duration without its basis is a claim. */
export const LATENCY_BASIS_LABELS: Record<string, string> = {
  evidence_span_union: "evidence span union",
  setup_phase_wall: "setup wall clock",
};

export function formatLatency(
  aggregate:
    | { unit: string; basis: string; sampleCount: number; totalMs: number }
    | undefined,
): string | null {
  const mean = latencyMeanMs(aggregate);
  // `null`, not `0`: a mean of no samples is not a fast server.
  if (mean === null || aggregate === undefined) return null;
  const basis = LATENCY_BASIS_LABELS[aggregate.basis] ?? aggregate.basis;
  return `${Math.round(mean)} ${aggregate.unit} · ${basis}`;
}

// ── slices ───────────────────────────────────────────────────────────────────
export interface SliceView {
  key: string;
  /** What this slice is, in words. `null` intent becomes "Unlabeled". */
  title: string;
  /** A second line when the dimension carries one (provider, engine). */
  subtitle: string | null;
  includedTrials: number;
  exclusions: string[];
  failureCategories: { category: string; count: number }[];
  stages: StageRowView[];
}

export function sliceTitle(slice: EvalStageAnalyticsSliceRow["slice"]): string {
  switch (slice.dimension) {
    case "overall":
      return "Overall";
    case "intent":
      // `null` is the UNLABELLED slice and is a real population, not an
      // omission — never render the raw null, and never drop the row.
      return slice.intent ?? UNLABELED_INTENT_LABEL;
    case "model":
      return slice.model;
    case "host":
      return slice.hostName ?? slice.hostKey;
  }
}

function sliceSubtitle(
  slice: EvalStageAnalyticsSliceRow["slice"],
): string | null {
  switch (slice.dimension) {
    case "model":
      // Two providers serve models by the same name, so the provider is part
      // of the identity rather than decoration.
      return slice.provider;
    case "host":
      // ABSENT means not recorded — never say "emulated" for a missing engine.
      return slice.executionEngine ?? null;
    default:
      return null;
  }
}

export function toSliceView(
  row: EvalStageAnalyticsSliceRow,
  index: number,
): SliceView {
  return {
    key: `${row.slice.dimension}:${index}`,
    title: sliceTitle(row.slice),
    subtitle: sliceSubtitle(row.slice),
    includedTrials: row.includedTrials,
    exclusions: describeExclusions(row.excludedTrials),
    failureCategories: row.failureCategories.map((entry) => ({ ...entry })),
    // Position is meaning — the six tallies are a funnel and are never sorted.
    stages: row.stages.map(toStageRowView),
  };
}

/** The overall slice, which the contract guarantees is present exactly once. */
export function overallSlice(
  row: EvalStageAnalyticsV1,
): EvalStageAnalyticsSliceRow | null {
  return (
    row.slices.find((slice) => slice.slice.dimension === "overall") ?? null
  );
}

export function slicesOfDimension(
  row: EvalStageAnalyticsV1,
  dimension: "intent" | "model" | "host",
): SliceView[] {
  return row.slices
    .map((slice, index) => ({ slice, index }))
    .filter((entry) => entry.slice.slice.dimension === dimension)
    .map((entry) => toSliceView(entry.slice, entry.index));
}

// ── setup ────────────────────────────────────────────────────────────────────
export interface SetupView {
  phase: EvalSetupTally["phase"];
  label: string;
  uniqueAttempts: number;
  failedAttempts: number;
  serverAttributedFailures: number;
  impactedTrials: number;
  latency: string | null;
}

export const SETUP_PHASE_LABELS: Record<EvalSetupTally["phase"], string> = {
  connection: "Connection",
  discovery: "Discovery",
};

export function toSetupView(tally: EvalSetupTally): SetupView {
  return {
    phase: tally.phase,
    label: SETUP_PHASE_LABELS[tally.phase],
    uniqueAttempts: tally.uniqueAttempts,
    failedAttempts: tally.failedAttempts,
    serverAttributedFailures: tally.serverAttributedFailures,
    // May exceed the attempt count — one failed attempt can block many trials,
    // and that asymmetry is the reason this is counted separately.
    impactedTrials: tally.impactedTrials,
    latency: formatLatency(tally.latency),
  };
}

// ── run-level disclosures ────────────────────────────────────────────────────
export interface RunHeaderView {
  runId: string;
  /** `provisional` numbers may still move under the reader. Always said. */
  provisional: boolean;
  materializationLabel: string;
  includedTrials: number;
  totalTrials: number;
  /** "Trials in this run" — every count names its population. */
  populationLabel: string;
  completedAt: number | null;
  disclosures: string[];
}

export function toRunHeaderView(row: EvalStageAnalyticsV1): RunHeaderView {
  const provisional = row.materializationState === "provisional";
  const disclosures: string[] = [];

  if (row.sourceStageAnalyzerVersions !== undefined) {
    // A mixed-version row is not comparable to anything, including another
    // mixed one. Disclosed rather than silently averaged.
    disclosures.push(
      `Mixed stage analyzer versions (${row.sourceStageAnalyzerVersions.join(
        ", ",
      )}): stages mean subtly different things across a version bump.`,
    );
  }
  if (row.sourceMeasurementsSchemaVersions !== undefined) {
    disclosures.push(
      `Mixed measurement schema versions (${row.sourceMeasurementsSchemaVersions.join(
        ", ",
      )}).`,
    );
  }
  for (const truncation of row.sliceTruncation ?? []) {
    // A truncated slice array that looked complete would read as "these are
    // all the models" — the false comparison the cap record exists to prevent.
    disclosures.push(
      `Showing ${truncation.retained} of ${truncation.distinctValues} ${truncation.dimension} values — this is not the complete set.`,
    );
  }
  const excluded = describeExclusions(row.excludedTrials);
  if (excluded.length > 0) {
    disclosures.push(`Excluded: ${excluded.join("; ")}.`);
  }

  return {
    runId: row.runId,
    provisional,
    materializationLabel: provisional
      ? "provisional — a judge pass is still landing, so these numbers may change"
      : "final",
    includedTrials: row.includedTrials,
    totalTrials: row.totalTrials,
    populationLabel: `${row.includedTrials} of ${row.totalTrials} trials in this run`,
    completedAt: row.runCompletedAt ?? null,
    disclosures,
  };
}
