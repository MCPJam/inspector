/**
 * The iterations a finding is about, named on the page.
 *
 * They used to live behind a drawer as `Trial 3`, `Trial 7` — an index into
 * whatever array the page happened to hold, which is not an identity anyone
 * can act on. A reader deciding whether a finding matters needs the case, the
 * recorded iteration number and the outcome without opening anything, so the
 * list is inline and the drawer keeps only the evidence excerpts.
 *
 * `unknown` rows are iterations the page has not loaded. They are listed
 * rather than dropped: a finding that names six iterations and shows four is
 * lying about its own evidence.
 */
import { useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";
import {
  outcomeDotTone,
  outcomeLabel,
  outcomeTextTone,
} from "@/components/evals/iteration-outcome";

export type AffectedIterationRow = {
  iterationId: string;
  caseTitle: string;
  iterationNumber: number | null;
  client: string | null;
  model: string | null;
  result: string;
  canOpen: boolean;
};

const INITIAL = 5;

export function AffectedIterationsList({
  rows,
  total,
  ariaLabel,
  onOpen,
  detail,
}: {
  rows: readonly AffectedIterationRow[];
  /** The finding's own affected count, when more were counted than named. */
  total?: number;
  ariaLabel: string;
  onOpen?: (iterationId: string) => void;
  detail?: (row: AffectedIterationRow) => React.ReactNode;
}) {
  const [showAll, setShowAll] = useState(false);
  if (rows.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No iteration ids were recorded for this finding.
      </p>
    );
  }
  const visible = showAll ? rows : rows.slice(0, INITIAL);
  return (
    <div className="space-y-2">
      <ul
        className="divide-y divide-border/50"
        aria-label={ariaLabel}
        data-testid="affected-iterations"
      >
        {visible.map((row) => (
          <li key={row.iterationId} className="py-1.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  outcomeDotTone(row.result),
                )}
                aria-hidden="true"
              />
              <span className="min-w-0 text-xs">
                <span className="text-foreground">{row.caseTitle}</span>
                {row.iterationNumber !== null ? (
                  <span className="text-muted-foreground">
                    {" · "}Iteration {row.iterationNumber}
                  </span>
                ) : null}
                {row.client ? (
                  <span className="text-muted-foreground">
                    {" · "}
                    {row.client}
                  </span>
                ) : null}
                {row.model ? (
                  <span className="text-muted-foreground">
                    {" · "}
                    {row.model}
                  </span>
                ) : null}
              </span>
              <span
                className={cn(
                  "ml-auto shrink-0 text-xs",
                  outcomeTextTone(row.result),
                )}
              >
                {outcomeLabel(row.result)}
              </span>
              {row.canOpen && onOpen ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 shrink-0 px-2 text-xs"
                  onClick={() => onOpen(row.iterationId)}
                >
                  Open
                  <ArrowUpRight className="size-3" aria-hidden="true" />
                </Button>
              ) : null}
            </div>
            {detail ? (
              <div className="mt-1 break-words text-[11.5px] leading-relaxed text-muted-foreground">
                {detail(row)}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {rows.length > INITIAL ? (
        <button
          type="button"
          className="min-h-8 text-xs font-medium text-foreground underline-offset-4 hover:underline"
          onClick={() => setShowAll(!showAll)}
          aria-expanded={showAll}
        >
          {showAll ? "Show fewer" : `Show all ${rows.length}`}
        </button>
      ) : null}
      {total !== undefined && total > rows.length ? (
        <p className="text-[11.5px] text-muted-foreground">
          Only recorded examples are listed ({rows.length} of {total}).
        </p>
      ) : null}
    </div>
  );
}
