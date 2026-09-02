/**
 * The chip on one stage card, derived from that stage's tally.
 *
 * PURE — no React, no fetching, no clock, and no arithmetic beyond comparing
 * counts to zero. Same split as `stage-analytics-model.ts`, for the same
 * reason: the honest-state rules are the interesting part and they are worth
 * testing without a DOM.
 *
 * ── This summarizes a tally. It does not decide anything ─────────────────────
 *
 * D9's decision summary is the authority on whether a run passed and why. D5c
 * — the document these tallies come from — describes where the execution chain
 * was measured as passing, failing or unmeasured, and this module says which of
 * those a card should wear. It is a SECOND RENDERING of numbers the
 * materializer already computed, never a second derivation of them: nothing
 * here re-counts trials, re-attributes a failure, or produces a verdict, and a
 * chip that disagreed with the rates printed underneath it would be a bug in
 * this file rather than a finding about the run.
 *
 * ── The rule that shapes every branch below ──────────────────────────────────
 *
 * **A stage with `measured === 0` never wears a pass word.** Not "passed", not
 * "ok", not a green tone, not an empty chip that reads as fine. Nothing was
 * decided, and the five states in `STAGE_STATES` exist precisely so that "we
 * never checked" cannot be rendered as "it worked". So the unmeasured branch
 * picks the most alarming honest state present and says it in that state's own
 * words.
 */
import {
  STAGE_STATE_LABELS,
  USER_VALUE_STAGES,
  USER_VALUE_STAGE_LABELS,
  USER_VALUE_STAGE_OUTCOMES,
  type EvalStageTally,
  type UserValueStage,
} from "@mcpjam/sdk/contract";

/**
 * What a stage card's chip says, as one closed vocabulary.
 *
 * `noTrials` is deliberately NOT one of the unmeasured states. "This stage was
 * never applicable to anything in this run" and "nothing at all ran" are
 * different facts, and the second is a statement about the run rather than
 * about the stage.
 */
export type StageChipKind =
  /** Measured, and everything measured held. */
  | "passed"
  /** Measured, and some of it held while some did not. */
  | "mixed"
  /** Measured, and none of what was measured held. */
  | "failed"
  /** Nothing was decided here. The chip says WHICH kind of nothing. */
  | "unmeasured"
  /** The stage tallied nothing at all — no population to describe. */
  | "noTrials";

/**
 * The tone a chip carries, in APP TOKENS.
 *
 * Same four tones and the same token names `DECISION_VERDICT_TONE_CLASS` uses
 * on the run's verdict card, so a failing stage and a failing verdict are the
 * same red on the same screen. The mocks' hexes are deliberately not copied:
 * a hardcoded `#b45309` is right in exactly one theme and wrong in the other.
 */
export const STAGE_CHIP_TONE_CLASS: Record<StageChipKind, string> = {
  passed: "text-success",
  mixed: "text-amber-700 dark:text-amber-400",
  failed: "text-destructive",
  // NEUTRAL, and that is the whole point. An unmeasured stage is not a warning
  // about the server — it is an absence of evidence about it, and an amber
  // chip would send a reader to fix something nothing observed.
  unmeasured: "text-muted-foreground",
  noTrials: "text-muted-foreground",
};

export interface StageChip {
  kind: StageChipKind;
  /** The words on the chip. Never a wire spelling, never a bare count. */
  label: string;
  toneClass: string;
}

/**
 * The unmeasured states, MOST ALARMING FIRST.
 *
 * The order is the tie-break when a stage's unmeasured trials are spread
 * across several of them, and it is ordered by how much a reader needs to know
 * about each. `notReached` says an earlier stage failed and this one never got
 * its chance — the most consequential thing on the list. `reachUnknown` says
 * the instrumentation captured nothing, so we cannot even say whether it ran.
 * `notApplicable` is last because it is the one that is genuinely fine.
 */
const UNMEASURED_PRECEDENCE = [
  "notReached",
  "notMeasured",
  "reachUnknown",
  "notApplicable",
] as const;
type UnmeasuredState = (typeof UNMEASURED_PRECEDENCE)[number];

/**
 * The words for each unmeasured state.
 *
 * Three are `STAGE_STATE_LABELS`', read from the contract so a stage state
 * means the same thing here as it does on a trial's chain rows. `reachUnknown`
 * is NOT a `StageState` — it is a tally column with no row-level counterpart —
 * so this module owns its words, written in the same voice as its neighbours.
 */
const UNMEASURED_LABELS: Record<UnmeasuredState, string> = {
  notReached: STAGE_STATE_LABELS.notReached,
  notMeasured: STAGE_STATE_LABELS.notMeasured,
  reachUnknown: "nothing captured — reach undecidable",
  notApplicable: STAGE_STATE_LABELS.notApplicable,
};

/**
 * The chip for one stage, from its counts alone.
 *
 * FIRST MATCH WINS, and the order of the branches is the claim:
 *
 *   1. some passed and some failed → `mixed`. Said before either pure verdict,
 *      because "2 of 3 failed" is a different finding from "it failed" and
 *      collapsing it loses the population that makes it actionable.
 *   2. anything failed → `failed`.
 *   3. anything was measured → `passed`.
 *   4. nothing was measured → the dominant honest state, in words.
 *   5. nothing at all → `noTrials`.
 *
 * Branch 3 is reachable only when `failed === 0` and `measured > 0`, which the
 * schema's own refinement (`passed + failed === measured`) makes equivalent to
 * `passed === measured`. So a pass word is only ever printed over a population
 * that was actually decided.
 */
export function deriveStageChip(tally: EvalStageTally): StageChip {
  const { measured, passed, failed } = tally;

  if (failed > 0 && passed > 0) {
    return {
      kind: "mixed",
      // The population, then the split. A bare "mixed" tells a reader that
      // something is wrong and nothing about how much of the run it touched.
      label: `mixed — ${passed} passed, ${failed} failed of ${measured} measured`,
      toneClass: STAGE_CHIP_TONE_CLASS.mixed,
    };
  }
  if (failed > 0) {
    return {
      kind: "failed",
      label: `failed in ${failed} of ${measured} measured`,
      toneClass: STAGE_CHIP_TONE_CLASS.failed,
    };
  }
  if (measured > 0) {
    return {
      kind: "passed",
      // The OUTCOME phrase, not the word "passed": a row reading
      // "Session connected → Tools and resources discovered → Usable response
      // returned" tells the delivery story, where six "passed" chips tell a
      // reader only that six checks ran.
      label: USER_VALUE_STAGE_OUTCOMES[tally.stage],
      toneClass: STAGE_CHIP_TONE_CLASS.passed,
    };
  }

  // Nothing was decided. Say WHICH nothing, in that state's own words, and
  // never in a word that could be read as a pass.
  const dominant = dominantUnmeasuredState(tally);
  if (dominant === null) {
    return {
      kind: "noTrials",
      label: "no trials",
      toneClass: STAGE_CHIP_TONE_CLASS.noTrials,
    };
  }
  return {
    kind: "unmeasured",
    label: `${dominant.count} ${UNMEASURED_LABELS[dominant.state]}`,
    toneClass: STAGE_CHIP_TONE_CLASS.unmeasured,
  };
}

/**
 * The unmeasured state that accounts for the most trials, or `null` for none.
 *
 * Ties break by {@link UNMEASURED_PRECEDENCE}, which is why the loop keeps the
 * first strict maximum rather than the last: with the array already in
 * most-alarming-first order, a strict `>` comparison makes the earlier entry
 * win a tie without a second sort.
 */
function dominantUnmeasuredState(
  tally: EvalStageTally,
): { state: UnmeasuredState; count: number } | null {
  const counts: Record<UnmeasuredState, number> = {
    notReached: tally.notReached,
    notMeasured: tally.notMeasured,
    reachUnknown: tally.reachUnknown,
    notApplicable: tally.notApplicable,
  };
  let best: { state: UnmeasuredState; count: number } | null = null;
  for (const state of UNMEASURED_PRECEDENCE) {
    const count = counts[state];
    if (count > 0 && (best === null || count > best.count)) {
      best = { state, count };
    }
  }
  return best;
}

/** One card in the chain row. */
export interface StageCardView {
  stage: UserValueStage;
  /** `01`..`06` — position is meaning; the chain is walked in this order. */
  ordinal: string;
  label: string;
  chip: StageChip;
}

export function toStageCardViews(
  tallies: readonly EvalStageTally[],
): StageCardView[] {
  // Position is meaning, so this maps the tallies AS GIVEN and never sorts.
  // The contract already guarantees six rows in `USER_VALUE_STAGES` order.
  return tallies.map((tally, index) => ({
    stage: tally.stage,
    ordinal: String(index + 1).padStart(2, "0"),
    label: USER_VALUE_STAGE_LABELS[tally.stage],
    chip: deriveStageChip(tally),
  }));
}

/**
 * Which stage to open on, or `null` for none.
 *
 * The FIRST break in the chain, in chain order — a failure at `selection`
 * explains the `notReached` at `call` after it, so opening on the later one
 * would put a reader in front of a consequence and call it a finding.
 *
 * `null` on a clean run is deliberate. With nothing broken there is no "what
 * happened" to answer, and auto-opening a detail card anyway would manufacture
 * a question the run did not raise.
 */
export function defaultSelectedStage(
  cards: readonly StageCardView[],
): UserValueStage | null {
  const broken = cards.find(
    (card) => card.chip.kind === "failed" || card.chip.kind === "mixed",
  );
  return broken?.stage ?? null;
}

/** The chain's stages, re-exported so a renderer need not reach past this. */
export { USER_VALUE_STAGES };
