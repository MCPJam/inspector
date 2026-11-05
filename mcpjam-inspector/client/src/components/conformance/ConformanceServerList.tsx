/**
 * The Conformance home once servers have runs: one card per server with its
 * latest result, a link to that run, and a one-click Run with the server's
 * default checks.
 */

import { Button } from "@mcpjam/design-system/button";
import { type ConformanceRunListItem } from "./ConformanceHistory";
import { RunResultRing } from "./RunResultRing";
import { ServerAvatar } from "./conformance-ui";

export function ConformanceServerList({
  runs,
  serverIcons,
  onViewRun,
  onRun,
  disabled = false,
  disabledServerName,
}: {
  /** Each server's latest run, by server name. */
  runs: Array<{ serverName: string; run: ConformanceRunListItem }>;
  /** Each server's logo URL, by name; initials where there is none. */
  serverIcons?: Record<string, string>;
  onViewRun: (runId: string) => void;
  onRun: (serverName: string) => void;
  /** A run is connecting, or the saved defaults are still loading. */
  disabled?: boolean;
  /** The server whose saved defaults could not be loaded. */
  disabledServerName?: string;
}) {
  return (
    <ul className="flex w-full flex-col gap-4" aria-label="Servers">
      {runs.map(({ serverName, run }) => (
        <li
          key={serverName}
          className="flex items-center justify-between gap-6 rounded-lg bg-popover px-6 py-4 text-popover-foreground shadow-sm"
        >
          <div className="flex min-w-0 grow items-center gap-3">
            <ServerAvatar
              name={serverName}
              iconUrl={serverIcons?.[serverName]}
              className="size-9"
            />
            <div className="flex min-w-0 items-baseline gap-2">
              <span className="truncate text-[15px] font-semibold">
                {serverName}
              </span>
              <span className="shrink-0 text-sm text-muted-foreground">
                · Protocol {run.protocolVersion ?? "Auto"}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-4">
            <span className="flex w-6 justify-center">
              <RunResultRing run={run} />
            </span>
            <span className="w-16 text-right text-xl font-semibold tabular-nums">
              {run.passed}/{run.applicable}
            </span>
            <span className="w-10 text-right text-sm tabular-nums text-muted-foreground">
              {run.score == null ? "—" : `${Math.round(run.score)}%`}
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
              disabled={disabled || disabledServerName === serverName}
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
