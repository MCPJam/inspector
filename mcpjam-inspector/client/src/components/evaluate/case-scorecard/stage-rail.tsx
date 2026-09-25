/**
 * The chain as a rail: six links in a column, one open at a time.
 *
 * WHY A RAIL AND NOT A STACK. The Scorecard's rows are long — an EXPECTED and
 * an ACTUAL sentence each, plus the stage's own explanation — so six stages
 * stacked put the one that broke an unknown distance below the fold, with five
 * passing sections to scroll past first. The rail states all six at once in the
 * space of one, and opens on the break.
 *
 * WHAT A CELL SAYS. A dot, the stage's ordinal, and its name. The dot carries
 * TONE ONLY: the state WORD lives on the open section's heading, where a reader
 * is already looking at that stage's rows, so nothing states the same verdict
 * twice. The word still reaches a screen reader through the button's accessible
 * name, because a colour is not a label.
 *
 * ORDINALS ARE THE STAGE'S OWN. `01`..`06` come from the stage's place in
 * `USER_VALUE_STAGES`, never from its index in this list. A chain that recorded
 * five rows must not renumber the survivors: position is meaning, and `04` next
 * to `call` is a claim about where in the delivery story the reader is standing.
 */

import type { StageResultRow, UserValueStage } from "@mcpjam/sdk/contract";
import {
  USER_VALUE_STAGES,
  USER_VALUE_STAGE_LABELS,
} from "@mcpjam/sdk/contract";
import { STAGE_CHIP_TONE_CLASS } from "../stage-chain-model";
import { deriveTrialStageChip } from "../stage-trial-model";
import { MASKED_STAGE_LABEL } from "../trial-chain-panel";
import { cn } from "@/lib/utils";

/**
 * The words for a stage the chain recorded no row for, which is only reachable
 * when something grades a stage the analyzer left out. "not measured" would be
 * a claim the chain never made; this says the read came up empty instead.
 */
export const NO_RECORDED_STATE_LABEL = "no recorded state";

export type StageRailCell = {
  stage: UserValueStage;
  /** `01`..`06`, from the stage's place in the chain. */
  ordinal: string;
  label: string;
  /** The state word, for the accessible name only. Never rendered as text. */
  stateLabel: string;
  toneClass: string;
};

/**
 * One cell per stage the Scorecard has a section for, in chain order.
 *
 * PURE. The chip comes from `deriveTrialStageChip`, the same derivation the run
 * page's cards use, so a stage cannot be red on one surface and green on the
 * other. A masked stage is neutral and says so: blind review withholds the
 * judge's verdict, and a red dot beside `User value` would publish it.
 */
export function buildStageRailCells({
  stages,
  rows,
  maskedStage = null,
}: {
  stages: readonly UserValueStage[];
  rows: ReadonlyMap<UserValueStage, StageResultRow>;
  maskedStage?: UserValueStage | null;
}): StageRailCell[] {
  return stages.map((stage) => {
    const base = {
      stage,
      ordinal: String(USER_VALUE_STAGES.indexOf(stage) + 1).padStart(2, "0"),
      label: USER_VALUE_STAGE_LABELS[stage],
    };
    if (stage === maskedStage) {
      return {
        ...base,
        stateLabel: MASKED_STAGE_LABEL,
        toneClass: STAGE_CHIP_TONE_CLASS.unmeasured,
      };
    }
    const row = rows.get(stage);
    if (!row) {
      return {
        ...base,
        stateLabel: NO_RECORDED_STATE_LABEL,
        toneClass: STAGE_CHIP_TONE_CLASS.unmeasured,
      };
    }
    const chip = deriveTrialStageChip(row);
    return { ...base, stateLabel: chip.label, toneClass: chip.toneClass };
  });
}

export function StageRail({
  cells,
  selected,
  onSelect,
}: {
  cells: readonly StageRailCell[];
  selected: UserValueStage | null;
  onSelect: (stage: UserValueStage) => void;
}) {
  return (
    <nav className="space-y-1" aria-label="Iteration stages">
      {cells.map((cell) => (
        <button
          key={cell.stage}
          type="button"
          data-testid="stage-rail-item"
          data-stage={cell.stage}
          // The state reaches a screen reader here, once, rather than from a
          // title on the dot that a keyboard reader never hears.
          aria-label={`${cell.ordinal} ${cell.label}: ${cell.stateLabel}`}
          aria-pressed={selected === cell.stage}
          // No toggle off: this pane has nowhere to fall back to, and a rail
          // with nothing open beside it reads as a failed read.
          onClick={() => onSelect(cell.stage)}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-xs hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring",
            selected === cell.stage && "bg-muted font-semibold",
          )}
        >
          <span className={cell.toneClass} aria-hidden="true">
            ●
          </span>
          <span className="font-mono text-[10px] text-muted-foreground">
            {cell.ordinal}
          </span>
          {cell.label}
        </button>
      ))}
    </nav>
  );
}
