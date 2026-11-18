import type { KeyboardEvent } from "react";
import { FeatureCountsText } from "./FeatureCounts";
import { FEATURE_NAV_SELECTOR, FeatureFamilyGroup } from "./FeatureRows";
import type { FeatureCardHandlers } from "./ServerCanvasCards";
import type { CardModel } from "./feature-tree";

const NAV_KEYS = new Set(["ArrowDown", "ArrowUp", "Home", "End"]);

/**
 * The canvas rows as a plain list: every card as a section, every family as
 * a disclosure, every feature as a button. Up and Down move between them,
 * Home and End jump to the first and last.
 */
export function ServerFeatureList({
  cards,
  handlers,
}: {
  cards: readonly CardModel[];
  handlers: FeatureCardHandlers;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!NAV_KEYS.has(event.key)) return;
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(FEATURE_NAV_SELECTOR),
    );
    if (items.length === 0) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown"
            ? Math.min(index + 1, items.length - 1)
            : Math.max(index - 1, 0);
    items[next]?.focus();
  };

  return (
    <div
      data-testid="server-feature-list"
      onKeyDown={onKeyDown}
      className="flex h-full flex-col gap-6 overflow-y-auto px-1 py-2"
    >
      {cards.map((card) => (
        <section key={card.id} aria-labelledby={`feature-list-${card.id}`}>
          <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-2">
            <h3
              id={`feature-list-${card.id}`}
              className="text-sm font-semibold text-foreground"
            >
              {card.name}
            </h3>
            <FeatureCountsText counts={card.counts} />
          </div>
          <div className="flex flex-col gap-0.5">
            {card.families.map((family) => (
              <FeatureFamilyGroup
                key={family.family.id}
                model={family}
                expanded={handlers.isExpanded(family.family.id)}
                selectedId={handlers.selectedId}
                onActivate={handlers.onActivateFamily}
                onSelect={handlers.onSelect}
                onOpenRun={handlers.onOpenRun}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
