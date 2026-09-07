/**
 * The left rail of a scorer row: when it runs, and what kind it is.
 *
 * WHY A RAIL AT ALL. The Steps pane is legible at a glance because every row
 * opens with a numbered badge and a coloured kind. The first version of this
 * list opened every row with the same chevron and the same grey text, so
 * nothing anchored the eye and the only thing telling two rows apart was the
 * sentence itself.
 *
 * WHY THE NUMBERS ARE NOT 1..N. This list is grouped by the link of the chain
 * each scorer measures, which is not the order things happen: a `firstToolWas`
 * check files under Selection and a `responseContains` check files under User
 * value, yet both run during execution, interleaved. Numbering down the page
 * would give every Selection row a lower number than every User value row and
 * claim an order that was never run.
 *
 * So a number appears only where a real one exists — a step's own position,
 * the same number the Steps pane shows it under. Everything else says WHEN it
 * runs instead: whole-run checks are graded once over the finished transcript,
 * and the judge goes last.
 */

import { Gavel, ListChecks, Route as RouteIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ScorecardRow } from "./case-scorecard-model";

const WHEN: Record<string, string> = {
  route: "Graded over the trial's tool calls, after the run",
  case: "Graded once, over the finished transcript",
  suite: "Graded once, over the finished transcript",
  snapshot: "Graded once, over the finished transcript",
  judge: "Runs last, after every check",
};

export function whenLabel(row: ScorecardRow): string {
  if (row.provenance === "step") {
    return row.stepNumber === undefined
      ? "Graded where it sits in the run"
      : `Step ${row.stepNumber} — graded when the run reaches it`;
  }
  return WHEN[row.provenance] ?? "";
}

export function RowMarker({ row }: { row: ScorecardRow }) {
  const title = whenLabel(row);
  if (row.provenance === "step" && row.stepNumber !== undefined) {
    return (
      <span
        title={title}
        data-testid="scorecard-row-marker"
        data-step-number={row.stepNumber}
        className="w-4 shrink-0 text-center text-xs tabular-nums text-muted-foreground"
      >
        {row.stepNumber}
      </span>
    );
  }
  const Icon =
    row.provenance === "route"
      ? RouteIcon
      : row.provenance === "judge"
        ? Gavel
        : ListChecks;
  return (
    <span
      title={title}
      data-testid="scorecard-row-marker"
      className="flex w-4 shrink-0 justify-center"
    >
      <Icon
        className={cn(
          "h-3.5 w-3.5",
          row.provenance === "judge"
            ? "text-violet-600 dark:text-violet-400"
            : row.provenance === "route"
              ? "text-sky-600 dark:text-sky-400"
              : "text-muted-foreground",
        )}
        aria-hidden
      />
    </span>
  );
}
