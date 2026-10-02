/**
 * The suite's evaluators, folded into one line that opens to the rows.
 *
 * They are inherited, so a case page reads them rather than authors them; the
 * count and roles are enough until someone asks for the list. A row that
 * failed on a run opens the fold, because a failure should never sit behind
 * a click.
 */

import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatStageConfigLine } from "@/components/evals/suite-scorer-table-model";
import type { ScorecardRow } from "./case-scorecard-model";

export function SuiteRowsDisclosure({
  rows,
  defaultOpen = false,
  children,
}: {
  rows: readonly ScorecardRow[];
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const required = rows.filter((row) => row.role === "required").length;
  const roles = formatStageConfigLine({
    required,
    advisory: rows.length - required,
  });
  const noun = rows.length === 1 ? "suite evaluator" : "suite evaluators";
  return (
    <div className="space-y-1.5" data-testid="suite-rows-disclosure">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1.5 text-left text-[11px] text-muted-foreground hover:text-foreground"
      >
        <ChevronRight
          className={cn(
            "h-3 w-3 shrink-0 transition-transform",
            open && "rotate-90",
          )}
        />
        <span>
          {rows.length} {noun} · {roles}
        </span>
      </button>
      {open ? children : null}
    </div>
  );
}
