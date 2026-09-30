/**
 * The "most of this run errored" callout. Every string comes from
 * {@link buildRunErrorBreakdown}; this file only lays it out.
 */
import { ArrowUpRight, TriangleAlert } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";

import type {
  RunErrorBreakdown as RunErrorBreakdownView,
  RunErrorOwner,
} from "./run-error-breakdown-model";

const OWNER_LABEL: Record<RunErrorOwner, string> = {
  yourServer: "Your server",
  yourTest: "Your test",
  mcpjam: "MCPJam",
  unclear: "Unclear",
};

export function RunErrorBreakdown({
  breakdown,
  onOpenIteration,
}: {
  breakdown: RunErrorBreakdownView | null;
  onOpenIteration?: (iterationId: string) => void;
}) {
  if (!breakdown) return null;
  return (
    <section
      role="status"
      aria-label="Why results errored"
      className="mx-5 mb-4 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3"
      data-testid="run-error-breakdown"
    >
      <h4 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <TriangleAlert className="size-4 text-warning" aria-hidden />
        {breakdown.headline}
      </h4>
      <p className="mt-1 text-[12.5px] text-muted-foreground">
        Here is what caused them and who needs to act.
      </p>
      <ul className="mt-3 space-y-3">
        {breakdown.groups.map((group) => (
          <li
            key={group.cause}
            className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2"
            data-testid="run-error-group"
            data-cause={group.cause}
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="rounded border border-border/60 bg-background px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {OWNER_LABEL[group.owner]}
                </span>
                <span className="text-sm font-medium text-foreground">
                  {group.title}
                </span>
                <span className="text-sm tabular-nums text-muted-foreground">
                  ({group.count} of {breakdown.finished})
                </span>
              </div>
              <p className="mt-1 max-w-[72ch] text-sm leading-relaxed text-foreground">
                {group.nextStep}
              </p>
            </div>
            {onOpenIteration ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 shrink-0"
                onClick={() => onOpenIteration(group.exampleIterationId)}
                data-testid="run-error-group-open"
              >
                Open one
                <ArrowUpRight className="h-3.5 w-3.5" />
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
