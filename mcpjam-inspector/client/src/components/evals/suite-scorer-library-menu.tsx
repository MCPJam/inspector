/**
 * Add-scorer library, grouped by the stage each kind measures.
 *
 * Categories come from `PREDICATE_STAGE` and `GRADER_PRESENTATION_GROUP`
 * via `scorerLibraryCategories` — empty sections are omitted, so Response
 * does not appear until a kind files there.
 */

import { EvalAddDrawer } from "@/components/evaluate/case-spine/assertion-drawer";
import { useFeatureFlagEnabled } from "posthog-js/react";
import type { Predicate } from "@mcpjam/sdk/predicates";
import type { WidgetAssertion } from "@/shared/steps";
import { SYNTHETIC_MONITOR_KINDS } from "./predicate-kind-meta";
import { scorerLibraryCategories } from "./suite-scorer-table-model";

export function SuiteScorerLibraryMenu({
  onAdd,
  kinds,
  authorableKinds,
  triggerLabel = "Add scorer",
  triggerClassName,
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
   * The kinds this DEPLOYMENT accepts (`authorablePredicateKinds`). Offering
   * a kind the backend rejects turns "Add scorer" into a failed save, and one
   * an older runner cannot evaluate fails closed on every trial.
   *
   * Independent of `kinds` and intersected with it: that one is about this
   * SURFACE, this one about the SERVER, and a kind has to clear both. Omitted
   * means the caller has not resolved the deployment's answer — the callers
   * that care resolve it themselves, so a default here would quietly narrow
   * the surfaces that do not.
   */
  authorableKinds?: readonly Predicate["type"][];
  /**
   * What the button says. The suite table's "Add scorer" is the default; the
   * spine says "Add a check after this", because there the menu answers WHERE
   * as well as what, and a generic label would lose the position.
   */
  triggerLabel?: string;
  triggerClassName?: string;
  /**
   * Offers DOM-level widget assertions alongside the predicates, under their
   * own category. Only a surface that can place a check at a position can
   * accept one — a widget assertion grades the view as it stood at that point,
   * so it is meaningless as a whole-run check.
   */
  onAddWidgetCheck?: (kind: WidgetAssertion["kind"]) => void;
}) {
  return (
    <EvalAddDrawer
      wholeRunOnly
      allowWidgetChecks={Boolean(onAddWidgetCheck)}
      kinds={kinds}
      authorableKinds={authorableKinds}
      className={triggerClassName}
      triggerLabel={triggerLabel}
      onSelect={(choice) => {
        if (choice.kind === "check") onAdd(choice.predicateKind);
        else if (choice.kind === "widget-check")
          onAddWidgetCheck?.(choice.widgetKind);
      }}
    />
  );
}

export function useScorerLibraryCategories(
  kinds?: readonly Predicate["type"][],
  authorableKinds?: readonly Predicate["type"][],
) {
  const syntheticMonitorsEnabled = useFeatureFlagEnabled("synthetic-monitors");
  const offered =
    kinds && authorableKinds
      ? kinds.filter((kind) => authorableKinds.includes(kind))
      : (kinds ?? authorableKinds);
  const categories = scorerLibraryCategories(offered)
    .map((category) => ({
      ...category,
      kinds: category.kinds.filter(
        (kind) =>
          syntheticMonitorsEnabled || !SYNTHETIC_MONITOR_KINDS.has(kind),
      ),
    }))
    .filter((category) => category.kinds.length > 0);

  return categories;
}
