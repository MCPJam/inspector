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

export function TrialChainPanel({
  chain,
  nextAction,
  /** Resets the reader's selection when the pane swaps to another trial. */
  resetKey,
  heading,
}: {
  chain: EvalRunDecisionChain | null | undefined;
  nextAction?: string;
  resetKey?: string;
  heading?: ReactNode;
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
              "This trial's stage chain did not validate, so it is withheld."
            : "This trial recorded no stage chain."}
        </p>
      </div>
    );
  }

  const cards = toTrialCardViews(chain.stages);
  const selectedStage =
    chosenStage === undefined ? defaultSelectedTrialStage(chain) : chosenStage;
  const selectedRow =
    chain.stages.find((row) => row.stage === selectedStage) ?? null;

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
      {selectedRow ? (
        <TrialStageDetailCard
          row={selectedRow}
          {...(nextAction && selectedRow.stage === chain.firstFailedStage
            ? { nextAction }
            : {})}
        />
      ) : null}
    </div>
  );
}
