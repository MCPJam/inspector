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
import { isRecommendedDefaultPredicateKind } from "@mcpjam/sdk/contract";
import { PREDICATE_KIND_LABELS } from "@/shared/predicate-kinds";
import { SYNTHETIC_MONITOR_KINDS } from "./predicate-kind-meta";
import {
  LEGACY_PREDICATE_KINDS,
  NEW_SCORER_KINDS,
  scorerLibraryCategories,
  type ScorerLibraryCategory,
} from "./suite-scorer-table-model";

export function SuiteScorerLibraryMenu({
  onAdd,
  authorableKinds,
}: {
  onAdd: (kind: Predicate["type"]) => void;
  /**
   * The kinds this deployment accepts (`authorablePredicateKinds`). Offering
   * a kind the backend rejects turns "Add scorer" into a failed save, and one
   * an older runner cannot evaluate fails closed on every trial.
   */
  authorableKinds?: readonly Predicate["type"][];
}) {
  const syntheticMonitorsEnabled = useFeatureFlagEnabled("synthetic-monitors");
  const categories = scorerLibraryCategories(authorableKinds ?? LEGACY_PREDICATE_KINDS).map((category) => ({
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
          aria-label="Add scorer"
          className="h-8 gap-1.5 border-dashed text-xs"
        >
          <Plus className="h-3.5 w-3.5" />
          Add scorer
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={4} className="w-72 p-1">
        <div className="px-2 pb-1.5 pt-1">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Add scorer
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
              {/*
                "Recommended" outranks "New": a kind a new suite already
                starts with is not news to an author reading this menu, and
                two chips on one row is noise.
              */}
              {isRecommendedDefaultPredicateKind(kind) ? (
                <span
                  title="New suites start with this check, as Warn"
                  className="text-[10px] uppercase tracking-[0.06em] text-muted-foreground"
                >
                  Recommended
                </span>
              ) : NEW_SCORER_KINDS.includes(kind) ? (
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
