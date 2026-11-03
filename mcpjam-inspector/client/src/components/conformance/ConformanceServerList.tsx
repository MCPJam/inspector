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
import { ServerAvatar } from "./conformance-ui";

const lastRunDateFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

export function ConformanceServerList({
  runs,
  serverIcons,
  onViewRun,
  onRun,
  disabled = false,
}: {
  /** Each server's latest run, by server name. */
  runs: Array<{ serverName: string; run: ConformanceRunListItem }>;
  /** Each server's logo URL, by name; initials where there is none. */
  serverIcons?: Record<string, string>;
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
            <ServerAvatar
              name={serverName}
              iconUrl={serverIcons?.[serverName]}
              className="size-9"
            />
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate text-[15px] font-semibold">
                {serverName}
              </span>
              <span className="text-sm text-muted-foreground">
                Last run {lastRunDateFormat.format(run.createdAt)} · Protocol{" "}
                {run.protocolVersion ?? "Auto"}
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
