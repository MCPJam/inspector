/**
 * What History shows when a search or the server filter leaves no runs:
 * centered where the table would be, with a way out (clear the filter) and a
 * way forward (run a new check).
 */
import { Button } from "@mcpjam/design-system/button";
import { CirclePlay, FlaskConical, Search, X } from "lucide-react";
import { useConformanceRunRequest } from "./conformance-run-request";

export function ConformanceHistoryNoResults({
  match,
  clearLabel,
  onClear,
}: {
  /** The search text or the filtered server's name, shown quoted. */
  match: string;
  clearLabel: string;
  onClear: () => void;
}) {
  const runRequest = useConformanceRunRequest();
  return (
    <div
      className="flex min-h-64 flex-1 items-center justify-center"
      data-testid="conformance-history-no-match"
    >
      <div className="flex w-full max-w-md flex-col items-center px-4 text-center">
        <div className="relative mb-5">
          <div className="flex size-20 items-center justify-center rounded-full bg-primary/10">
            <div className="flex size-12 items-center justify-center rounded-full bg-background shadow-sm">
              <FlaskConical aria-hidden className="size-5 text-primary" />
            </div>
          </div>
          <div className="absolute -right-0.5 bottom-0.5 flex size-7 items-center justify-center rounded-full bg-foreground text-background ring-2 ring-background">
            <Search aria-hidden className="size-3.5" />
          </div>
        </div>

        <div role="status">
          <h3 className="text-base font-semibold text-foreground">
            No conformance runs found
          </h3>
          <p className="mt-1.5 text-sm leading-6 text-pretty text-muted-foreground">
            We couldn&rsquo;t find any test runs matching{" "}
            <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
              &ldquo;{match}&rdquo;
            </span>
            . Try adjusting your query or resetting your filters.
          </p>
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
          <Button variant="outline" size="sm" onClick={onClear}>
            <X aria-hidden className="size-4" />
            {clearLabel}
          </Button>
          {runRequest ? (
            <Button
              size="sm"
              onClick={runRequest.run}
              disabled={runRequest.disabled}
            >
              <CirclePlay aria-hidden className="size-4" />
              Run new check
            </Button>
          ) : null}
        </div>

        <div className="mt-8 w-full border-t border-dashed border-border" />
        <p className="mt-6 text-xs text-muted-foreground">
          Looking for another server?
        </p>
      </div>
    </div>
  );
}
