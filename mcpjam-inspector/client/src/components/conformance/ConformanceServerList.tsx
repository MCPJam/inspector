/**
 * The Conformance home once servers have runs: one card per server with its
 * latest result, a link to that run, and a one-click Run with the server's
 * default checks.
 */

import { Button } from "@mcpjam/design-system/button";
import {
  RunResultBadge,
  type ConformanceRunListItem,
} from "./ConformanceHistory";

const lastRunDateFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

function initialsOf(name: string): string {
  const letters = name.replace(/[^a-z0-9]/gi, "").slice(0, 2) || "?";
  return letters.charAt(0).toUpperCase() + letters.slice(1).toLowerCase();
}

export function ConformanceServerList({
  runs,
  onViewRun,
  onRun,
  disabled = false,
}: {
  /** Each server's latest run, by server name. */
  runs: Array<{ serverName: string; run: ConformanceRunListItem }>;
  onViewRun: (runId: string) => void;
  onRun: (serverName: string) => void;
  /** A run is connecting, or the saved defaults are still loading. */
  disabled?: boolean;
}) {
  return (
    <ul className="flex w-full flex-col gap-4" aria-label="Servers">
      {runs.map(({ serverName, run }) => (
        <li
          key={serverName}
          className="flex items-center justify-between gap-6 rounded-lg border border-border bg-card px-6 py-4"
        >
          <div className="flex min-w-0 grow items-center gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-[13px] font-bold text-primary">
              {initialsOf(serverName)}
            </span>
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate text-[15px] font-semibold">
                {serverName}
              </span>
              <span className="text-[13px] text-muted-foreground">
                Last run {lastRunDateFormat.format(run.createdAt)}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-4">
            <RunResultBadge run={run} />
            <span className="text-base font-semibold tabular-nums">
              {run.score == null ? "—" : `${Math.round(run.score)}%`}
            </span>
            <span className="text-base tabular-nums">
              {run.passed}/{run.applicable}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onViewRun(run._id)}
            >
              View last run
            </Button>
            <Button
              size="sm"
              disabled={disabled}
              onClick={() => onRun(serverName)}
              aria-label={`Run ${serverName}`}
            >
              Run
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}
