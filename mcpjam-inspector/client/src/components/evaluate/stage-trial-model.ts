/**
 * The chip on one stage card for ONE TRIAL, derived from that trial's own row.
 *
 * PURE — no React, no fetching, no clock, and no arithmetic at all. The sibling
 * of `stage-chain-model.ts`, which does the same job for a run's aggregate
 * tallies, and it exists because the two questions are genuinely different:
 *
 *   - a RUN's stage is a population ("2 of 3 measured trials failed here");
 *   - a TRIAL's stage is a single verdict ("this one failed here").
 *
 * A trial has no denominator, and inventing one — rendering "100% (1/1)" over a
 * single row — would manufacture a statistic out of one observation. So this
 * module never counts anything: it maps the row's `state` to a chip and stops.
 *
 * ── The rule that shapes the branches, restated for a single row ─────────────
 *
 * `STAGE_STATES` has five members and three of them are NOT verdicts:
 * `notReached`, `notMeasured` and `notApplicable` each say a different kind of
 * "nothing was decided here". Reporting any of them as healthy is the
 * misreading the five-state vocabulary exists to prevent, so only `passed`
 * earns a pass word and a success tone.
 *
 * ── Why the reason is NOT on the chip ────────────────────────────────────────
 *
 * Some `STAGE_REASON_LABELS` entries are whole sentences (the unavailable
 * match-verdict one runs past a hundred characters), and six cards at their
 * minimum width inside a diagnostic row would wrap into unreadable columns.
 * The aggregate `failed` chip already omits reasons for the same reason. It
 * also keeps the pass-word invariant total over the five STATES rather than
 * dependent on the 29-member reason vocabulary — two reason labels contain the
 * word "made", which the invariant's own regex matches. The detail card owns
 * the reason, where there is room to read it.
 */
import {
  STAGE_STATE_LABELS,
  USER_VALUE_STAGES,
  USER_VALUE_STAGE_LABELS,
  USER_VALUE_STAGE_OUTCOMES,
  type EvalRunDecisionChain,
  type StageResultRow,
  type UserValueStage,
} from "@mcpjam/sdk/contract";
import {
  STAGE_CHIP_TONE_CLASS,
  type StageCardView,
  type StageChip,
} from "./stage-chain-model";

/**
 * The words for a state this build has no label for.
 *
 * DEGRADE, NEVER THROW. A deployment can serve rows produced by an analyzer
 * newer than this bundle, and the honest answer to "what is `judgeDeferred`?"
 * is that this reader does not know — not a crash, and emphatically not a
 * guess that renders as a pass. Same posture as the shared session chain's
 * `UNKNOWN_STATE_META`.
 */
export const UNRECOGNIZED_STATE_LABEL = "state not recognized";

/**
 * The chip for one stage of one trial, from its row's state alone.
 *
 * Total over `StageState`, and deliberately written as an exhaustive switch so
 * a sixth member of the vocabulary breaks the build here rather than falling
 * through to a default that reads as fine.
 */
export function deriveTrialStageChip(row: StageResultRow): StageChip {
  switch (row.state) {
    case "passed":
      return {
        kind: "passed",
        // The OUTCOME phrase, not the word "passed" — the map is documented as
        // being for a stage measured as passed, which is exactly this branch,
        // and it makes the row read as the delivery story ("Session connected
        // → Tools and resources discovered → Request satisfied") instead of
        // six identical words.
        label: USER_VALUE_STAGE_OUTCOMES[row.stage],
        toneClass: STAGE_CHIP_TONE_CLASS.passed,
      };
    case "failed":
      return {
        kind: "failed",
        // The state word alone. See the header: the reason lives on the detail
        // card, where a sentence fits.
        label: STAGE_STATE_LABELS.failed,
        toneClass: STAGE_CHIP_TONE_CLASS.failed,
      };
    case "notReached":
    case "notMeasured":
    case "notApplicable":
      return {
        kind: "unmeasured",
        label: STAGE_STATE_LABELS[row.state],
        // NEUTRAL. An unmeasured stage is an absence of evidence about the
        // server, not a warning about it.
        toneClass: STAGE_CHIP_TONE_CLASS.unmeasured,
      };
    default:
      return {
        kind: "unmeasured",
        label: UNRECOGNIZED_STATE_LABEL,
        toneClass: STAGE_CHIP_TONE_CLASS.unmeasured,
      };
  }
}

/**
 * One trial's six rows as cards, in the order the chain gave them.
 *
 * POSITION IS MEANING: `notReached` is derived from a row's position in
 * `USER_VALUE_STAGES`, so a reordered row list is a different claim about
 * which stages were blocked. This maps AS GIVEN and never sorts — the contract
 * already guarantees six rows in chain order, and if a payload ever breaks
 * that guarantee the right outcome is a visibly wrong ordinal, not a silently
 * repaired one.
 */
export function toTrialCardViews(
  rows: readonly StageResultRow[],
): StageCardView[] {
  return rows.map((row, index) => ({
    stage: row.stage,
    ordinal: String(index + 1).padStart(2, "0"),
    label: USER_VALUE_STAGE_LABELS[row.stage],
    chip: deriveTrialStageChip(row),
  }));
}

/**
 * Which stage to open on for a trial, or `null` for none.
 *
 * THE CONTRACT'S OWN `firstFailedStage` whenever it has one, never re-derived.
 * The server decided where this chain stopped; scanning for the first `failed`
 * row here would be a second derivation of the same fact, and the day the two
 * disagree the UI would be the one that is wrong while looking authoritative.
 *
 * When the contract established NO first failed stage, this opens the first
 * non-passing row that carries a reason. That is the setup-abort and
 * policy-block shape: every stage reads `not measured` and the only thing a
 * reader wants — WHY nothing was measured — sits in a row's `reason`. Leaving
 * it closed hides the one sentence that explains the trial behind a click
 * nobody knows to make.
 *
 * It is a choice of which card to OPEN, never a claim that the stage failed:
 * the chip on that card still says `not measured`, and the row above still
 * says no first failed stage was established.
 *
 * `null` for the two non-verified statuses (there are no rows to open) and for
 * a trial that was delivered end to end — that raises no "what happened"
 * question, so auto-opening a card would manufacture one.
 */
export function defaultSelectedTrialStage(
  chain: EvalRunDecisionChain,
): UserValueStage | null {
  if (chain.status !== "verified") return null;
  if (chain.firstFailedStage) return chain.firstFailedStage;
  const explained = chain.stages.find(
    (row) => row.state !== "passed" && row.reason !== undefined,
  );
  return explained?.stage ?? null;
}

/** The chain's stages, re-exported so a renderer need not reach past this. */
export { USER_VALUE_STAGES };
