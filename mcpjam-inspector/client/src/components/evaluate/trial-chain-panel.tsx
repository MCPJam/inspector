/**
 * One trial's chain, as the card row plus its "what happened" card.
 *
 * The shared body behind both per-trial surfaces: the diagnostic row on the
 * run page, and the trace pane a reader lands on from "View trace". Same
 * components, same selection rule, same words — a second arrangement of the
 * same six cards is a second place for them to disagree.
 *
 * ── Selection: `undefined` is not `null` ─────────────────────────────────────
 *
 * `undefined` means the reader has not chosen, so the default is derived AT
 * RENDER TIME; `null` means they closed the card and it stays closed. The
 * distinction is load-bearing here rather than merely tidy: on the trace pane
 * the chain arrives AFTER mount, so a state initialized once from an empty
 * chain would compute `null` and never auto-open the break.
 */
import { useEffect, useState, type ReactNode } from "react";
import type {
  EvalRunDecisionChain,
  UserValueStage,
} from "@mcpjam/sdk/contract";
import { StageChainCards } from "./stage-chain-cards";
import { TrialStageDetailCard } from "./trial-stage-detail-card";
import {
  defaultSelectedTrialStage,
  toTrialCardViews,
} from "./stage-trial-model";
import { STAGE_CHIP_TONE_CLASS } from "./stage-chain-model";
import { USER_VALUE_STAGE_LABELS } from "@mcpjam/sdk/contract";

/** The words a masked card shows, everywhere it shows them. */
export const MASKED_STAGE_LABEL = "hidden until you label this iteration";

export function TrialChainPanel({
  chain,
  nextAction,
  detailByStage,
  stageFooter,
  /** Resets the reader's selection when the pane swaps to another trial. */
  resetKey,
  heading,
  layout = "cards",
  maskedStage = null,
  initialStage,
}: {
  chain: EvalRunDecisionChain | null | undefined;
  nextAction?: string;
  /**
   * A line under each card saying what GRADES that link on this case — "2
   * gates · 1 warn", "Observed by the runner", or, when a gap has something
   * that would fill it, "Nothing checks this · N suggested".
   *
   * Merged on top of the card views rather than computed inside
   * `toTrialCardViews`, which has no idea what the case authors and is pinned
   * by its own test to never set `detail`.
   */
  detailByStage?: Partial<
    Record<UserValueStage, { label: string; toneClass: string }>
  >;
  /** Rendered inside the selected stage's detail card. */
  stageFooter?: (stage: UserValueStage) => ReactNode;
  resetKey?: string;
  heading?: ReactNode;
  layout?: "cards" | "report";
  /**
   * One stage whose state, reason and evidence are withheld — blind judge
   * review, where the User value card would otherwise print the verdict the
   * reviewer is about to label. The other cards stay as they are: they were
   * decided by the runner, not the judge, and hiding them protects nothing.
   *
   * The masked card is still a card: it is auto-selected so the footer (where
   * the judge row and its label panel live) is on screen, and its chip is
   * neutral rather than absent. Selection is by RULE, not by state, so the
   * choice itself leaks nothing.
   */
  maskedStage?: UserValueStage | null;
  /**
   * The card to open before the reader chooses, when the caller has a rule
   * that outranks "the first failed stage". Blind review passes User value:
   * the judge row the reviewer must label lives in that card's footer, and a
   * default chosen by the trial's state would put it behind a click on some
   * trials and not others.
   */
  initialStage?: UserValueStage;
}) {
  const [chosenStage, setChosenStage] = useState<
    UserValueStage | null | undefined
  >(undefined);

  // A different trial is a different chain: carrying a selection across would
  // open a stage the new trial may not have broken at.
  useEffect(() => setChosenStage(undefined), [resetKey]);

  // Nothing to say YET is not the same as nothing to say. A pane whose read
  // has not landed renders nothing rather than an absent-chain notice, which
  // would be a claim about the trial rather than about the read.
  if (!chain) return null;

  if (chain.status !== "verified") {
    return (
      <div
        className="rounded-md border border-border/60 p-3"
        data-testid="trial-chain-unavailable"
        data-chain-status={chain.status}
      >
        {heading}
        <p className="text-[11px] text-muted-foreground">
          {chain.status === "unverified"
            ? // Withheld on purpose, and the reason is worth stating: the rows
              // exist and did not validate, so showing them would publish a
              // chain the server declined to vouch for.
              "This iteration's stage chain did not validate, so it is withheld."
            : "This iteration recorded no stage chain."}
        </p>
      </div>
    );
  }

  const cards = toTrialCardViews(chain.stages).map((card) => {
    if (card.stage === maskedStage) {
      return {
        ...card,
        chip: {
          kind: "unmeasured" as const,
          label: MASKED_STAGE_LABEL,
          toneClass: STAGE_CHIP_TONE_CLASS.unmeasured,
        },
      };
    }
    const detail = detailByStage?.[card.stage];
    return detail ? { ...card, detail } : card;
  });
  // A caller's rule first, then the masked card itself — never the first
  // failed stage while a mask is on, which would reveal whether the masked
  // stage is that stage.
  const selectedStage =
    chosenStage === undefined
      ? (initialStage ?? maskedStage ?? defaultSelectedTrialStage(chain))
      : chosenStage;
  const selectedRow =
    chain.stages.find((row) => row.stage === selectedStage) ?? null;
  const selectedIsMasked =
    selectedRow !== null && selectedRow.stage === maskedStage;

  if (layout === "report") {
    return (
      <div
        className="grid gap-6 rounded-lg border border-border/60 p-4 sm:grid-cols-[170px_minmax(0,1fr)]"
        data-testid="trial-chain-panel"
      >
        <nav className="space-y-1" aria-label="Iteration stages">
          {cards.map((card) => (
            <button
              key={card.stage}
              type="button"
              aria-label={`${card.ordinal} ${card.label}: ${card.chip.label}`}
              aria-pressed={selectedStage === card.stage}
              onClick={() => setChosenStage(card.stage)}
              className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-xs hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring ${
                selectedStage === card.stage ? "bg-muted font-semibold" : ""
              }`}
            >
              <span
                className={card.chip.toneClass}
                title={card.chip.label}
                aria-label={card.chip.label}
              >
                ●
              </span>
              <span className="font-mono text-[10px] text-muted-foreground">
                {card.ordinal}
              </span>
              {card.label}
            </button>
          ))}
        </nav>
        <div className="min-w-0 rounded-lg bg-card">
          {selectedRow && selectedIsMasked ? (
            <MaskedStageCard stage={selectedRow.stage}>
              {stageFooter?.(selectedRow.stage)}
            </MaskedStageCard>
          ) : selectedRow ? (
            <TrialStageDetailCard
              row={selectedRow}
              report
              {...(nextAction && selectedRow.stage === chain.firstFailedStage
                ? { nextAction }
                : {})}
            >
              {stageFooter?.(selectedRow.stage)}
            </TrialStageDetailCard>
          ) : (
            <p className="p-4 text-xs text-muted-foreground">
              Select a stage to inspect its recorded evidence.
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div data-testid="trial-chain-panel">
      {heading}
      <StageChainCards
        cards={cards}
        selected={selectedStage}
        onSelect={(stage) =>
          setChosenStage(selectedStage === stage ? null : stage)
        }
      />
      {selectedRow && selectedIsMasked ? (
        <MaskedStageCard stage={selectedRow.stage}>
          {stageFooter?.(selectedRow.stage)}
        </MaskedStageCard>
      ) : selectedRow ? (
        <TrialStageDetailCard
          row={selectedRow}
          {...(nextAction && selectedRow.stage === chain.firstFailedStage
            ? { nextAction }
            : {})}
        >
          {stageFooter?.(selectedRow.stage)}
        </TrialStageDetailCard>
      ) : null}
    </div>
  );
}

/**
 * The detail slot for a masked stage: the same frame as the detail card, with
 * the state, reason and evidence replaced by one line saying why. The footer
 * still renders, because that is where the reviewer labels.
 */
function MaskedStageCard({
  stage,
  children,
}: {
  stage: UserValueStage;
  children?: ReactNode;
}) {
  return (
    <div
      className="space-y-2 p-4"
      data-testid="trial-stage-masked"
      data-stage={stage}
    >
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        What happened
      </p>
      <p className="text-sm font-medium">{USER_VALUE_STAGE_LABELS[stage]}</p>
      <p className="text-xs text-muted-foreground">
        The judge decided this stage. Its result is {MASKED_STAGE_LABEL}.
      </p>
      {children}
    </div>
  );
}
