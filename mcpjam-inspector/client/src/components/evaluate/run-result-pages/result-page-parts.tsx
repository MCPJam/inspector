import type { ReactNode } from "react";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@mcpjam/design-system/cn";
import { Skeleton } from "@mcpjam/design-system/skeleton";
import { outcomeLabel } from "./outcome";

export function ResultPageTitle({
  title,
  badge,
  meta,
  actions,
}: {
  title: ReactNode;
  badge?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-start justify-between gap-3 px-6 pt-5 pb-4">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="break-words text-xl font-semibold tracking-tight text-foreground">
            {title}
          </h1>
          {badge}
        </div>
        {meta ? <p className="text-sm text-muted-foreground">{meta}</p> : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}

export function IterationResultBadge({ result }: { result: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "rounded-full text-[10px] font-semibold uppercase tracking-wide",
        result === "passed"
          ? "border-success/30 bg-success/10 text-success"
          : result === "failed" || result === "timed_out"
            ? "border-destructive/30 bg-destructive/10 text-destructive"
            : result === "pending"
              ? "border-pending/30 bg-pending/10 text-pending"
              : "border-border bg-muted text-muted-foreground",
      )}
    >
      {outcomeLabel(result)}
    </Badge>
  );
}

/** `readFailed`: a launch run's results did not load, so "no result" is unknown. */
export function ResultNotFound({
  runLabel,
  onOpenRun,
  readFailed = false,
}: {
  runLabel: string;
  onOpenRun: () => void;
  readFailed?: boolean;
}) {
  const midSentence = runLabel.replace(/^This run$/, "this run");
  return (
    <div
      className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center"
      data-testid="run-result-not-found"
    >
      <h1 className="text-lg font-semibold text-foreground">
        {readFailed
          ? `Couldn't load the results of ${midSentence}. Try again.`
          : `${runLabel} has no result at this link`}
      </h1>
      <p className="text-sm text-muted-foreground">
        {readFailed
          ? `Open ${midSentence} to load them again.`
          : `Open ${midSentence} to pick another result.`}
      </p>
      <Button variant="outline" onClick={onOpenRun}>
        Open {midSentence}
      </Button>
    </div>
  );
}

export function ResultPageSkeleton({ rows }: { rows: number }) {
  return (
    <div
      className="flex flex-col gap-4 px-6 pt-5"
      aria-busy="true"
      data-testid="run-result-page-skeleton"
    >
      <Skeleton className="h-7 w-96 max-w-full" />
      <Skeleton className="h-20 w-full rounded-xl" />
      {Array.from({ length: rows }, (_, row) => (
        <Skeleton key={row} className="h-10 w-full" />
      ))}
    </div>
  );
}
