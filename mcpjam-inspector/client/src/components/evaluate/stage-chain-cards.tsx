/**
 * The six stage cards, as a row that reads left to right.
 *
 * Connect → Discover → Select → Call → Respond → Satisfy. The row is the
 * request-delivery path, and each card says whether that link held, over how
 * many trials, in the vocabulary the contract already owns.
 *
 * ── Position is meaning ──────────────────────────────────────────────────────
 *
 * The cards are numbered 01–06 and rendered in `USER_VALUE_STAGES` order,
 * which `chain.ts` documents as normative: "not reached" is derived from
 * POSITION, so a row sorted by anything else would silently claim a different
 * set of blocked stages. Nothing here sorts, filters or reorders.
 *
 * ── What a click does, and what it must never do ─────────────────────────────
 *
 * Selecting a card opens its detail below. That is a VIEW change and nothing
 * more: no fetch, no re-derivation, no second opinion about the run. The
 * selected stage is held by the caller so both mounts of the document — the
 * suite panel and the run-detail slot — get the behaviour without either
 * knowing about the other.
 */
import { cn } from "@/lib/utils";
import type { UserValueStage } from "@mcpjam/sdk/contract";
import type { StageCardView } from "./stage-chain-model";

export function StageChainCards({
  cards,
  selected,
  onSelect,
}: {
  cards: StageCardView[];
  selected: UserValueStage | null;
  onSelect: (stage: UserValueStage) => void;
}) {
  return (
    <div
      className="flex flex-wrap items-stretch gap-1"
      data-testid="stage-chain-cards"
    >
      {cards.map((card, index) => (
        <div key={card.stage} className="flex items-stretch gap-1">
          <button
            type="button"
            onClick={() => onSelect(card.stage)}
            aria-pressed={selected === card.stage}
            data-testid={`stage-chain-card-${card.stage}`}
            data-chip={card.chip.kind}
            className={cn(
              "flex min-w-[8.5rem] flex-1 flex-col gap-0.5 rounded-md border px-2.5 py-2 text-left transition-colors",
              "hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              selected === card.stage
                ? // The selection ring, not a tone change: the chip's colour is
                  // the stage's own state and must not shift because a reader
                  // clicked it.
                  "border-foreground/40 bg-muted/50 ring-1 ring-foreground/20"
                : "border-border/60",
            )}
          >
            <span className="text-[9px] font-medium tabular-nums text-muted-foreground/70">
              {card.ordinal}
            </span>
            <span className="text-[11px] font-medium text-foreground">
              {card.label}
            </span>
            <span
              className={cn("text-[10px] leading-snug", card.chip.toneClass)}
            >
              {card.chip.label}
            </span>
          </button>
          {index < cards.length - 1 ? (
            // DECORATION. The order is already carried by the DOM order and by
            // each card's ordinal, so an arrow announced to a screen reader
            // would be a sixth "→" between six real labels.
            <span
              aria-hidden
              className="self-center text-[10px] text-muted-foreground/40"
            >
              →
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}
