/**
 * Add-scorer library, grouped by the stage each kind measures.
 *
 * Categories come from `PREDICATE_STAGE` and `GRADER_PRESENTATION_GROUP`
 * via `scorerLibraryCategories` — empty sections are omitted, so Response
 * does not appear until a kind files there.
 */

import { Plus } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import { useFeatureFlagEnabled } from "posthog-js/react";
import type { Predicate } from "@mcpjam/sdk/predicates";
import { PREDICATE_KIND_LABELS } from "@/shared/predicate-kinds";
import { WIDGET_ASSERTION_LABELS, type WidgetAssertion } from "@/shared/steps";
import { SYNTHETIC_MONITOR_KINDS } from "./predicate-kind-meta";
import {
  NEW_SCORER_KINDS,
  scorerLibraryCategories,
  type ScorerLibraryCategory,
} from "./suite-scorer-table-model";

export function SuiteScorerLibraryMenu({
  onAdd,
  kinds,
  triggerLabel = "Add scorer",
  onAddWidgetCheck,
}: {
  onAdd: (kind: Predicate["type"]) => void;
  /**
   * Which kinds this surface may offer. Omitted means every kind, which is
   * the suite's answer. The case page passes a narrowed list because one kind
   * is already owned by another control there (the route question owns
   * `toolCalledWith`), and offering it twice would let a reader author a route
   * that the route row then contradicts.
   */
  kinds?: readonly Predicate["type"][];
  /**
   * What the button says. The suite table's "Add scorer" is the default; the
   * spine says "Add a check after this", because there the menu answers WHERE
   * as well as what, and a generic label would lose the position.
   */
  triggerLabel?: string;
  /**
   * Offers DOM-level widget assertions alongside the predicates, under their
   * own category. Only a surface that can place a check at a position can
   * accept one — a widget assertion grades the view as it stood at that point,
   * so it is meaningless as a whole-run check.
   */
  onAddWidgetCheck?: (kind: WidgetAssertion["kind"]) => void;
}) {
  const syntheticMonitorsEnabled = useFeatureFlagEnabled("synthetic-monitors");
  const categories = scorerLibraryCategories(kinds).map((category) => ({
    ...category,
    kinds: category.kinds.filter(
      (kind) =>
        syntheticMonitorsEnabled || !SYNTHETIC_MONITOR_KINDS.has(kind),
    ),
  })).filter((category) => category.kinds.length > 0);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-haspopup="dialog"
          aria-label={triggerLabel}
          className="h-8 gap-1.5 border-dashed text-xs"
        >
          <Plus className="h-3.5 w-3.5" />
          {triggerLabel}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={4} className="w-72 p-1">
        <div className="px-2 pb-1.5 pt-1">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {triggerLabel}
          </span>
        </div>
        <ul className="space-y-2" data-testid="scorer-library">
          {categories.map((category) => (
            <LibraryCategory
              key={category.id}
              category={category}
              onAdd={onAdd}
            />
          ))}
          {onAddWidgetCheck ? (
            <li data-library-category="widget">
              <div className="px-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                In the view
              </div>
              <ul className="space-y-0.5">
                {(
                  Object.keys(WIDGET_ASSERTION_LABELS) as Array<
                    WidgetAssertion["kind"]
                  >
                ).map((kind) => (
                  <li key={kind}>
                    <button
                      type="button"
                      data-testid={`add-widget-check-${kind}`}
                      onClick={() => onAddWidgetCheck(kind)}
                      className="flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent/50"
                    >
                      <span>{WIDGET_ASSERTION_LABELS[kind]}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ) : null}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function LibraryCategory({
  category,
  onAdd,
}: {
  category: ScorerLibraryCategory;
  onAdd: (kind: Predicate["type"]) => void;
}) {
  return (
    <li data-library-category={category.id}>
      <div className="px-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {category.label}
      </div>
      <ul className="space-y-0.5">
        {category.kinds.map((kind) => (
          <li key={kind}>
            <button
              type="button"
              data-testid={`add-scorer-${kind}`}
              onClick={() => onAdd(kind)}
              className="flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent/50"
            >
              <span>{PREDICATE_KIND_LABELS[kind] ?? kind}</span>
              {NEW_SCORER_KINDS.includes(kind) ? (
                <span className="text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
                  New
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </li>
  );
}
