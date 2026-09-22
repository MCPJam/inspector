/**
 * Who wrote this scorer.
 *
 * A suite's Scorers table needs no such chip — everything there is the
 * suite's. A case has four authors: its route question, its own steps, its own
 * predicate list, and the suite's defaults. Without the chip, a reader looking
 * at a failing check cannot tell whether to edit this case or the suite, and
 * that is the first thing they want to know.
 */

import { cn } from "@/lib/utils";
import type { ScorecardProvenance } from "./case-scorecard-model";

const LABELS: Record<ScorecardProvenance, string> = {
  route: "Route",
  step: "Step",
  case: "This case",
  suite: "Suite",
  snapshot: "Run snapshot",
  judge: "Judge",
};

export function ProvenanceChip({
  provenance,
  className,
}: {
  provenance: ScorecardProvenance;
  className?: string;
}) {
  // No "Step N" here any more: the number moved to the row's left marker,
  // where it lines up with the Steps pane. Repeating it would say the same
  // thing twice on one line.
  const label = LABELS[provenance];
  return (
    <span
      data-provenance={provenance}
      className={cn(
        "shrink-0 rounded-sm border border-border/50 px-1.5 py-px text-[10px] text-muted-foreground",
        className,
      )}
    >
      {label}
    </span>
  );
}
