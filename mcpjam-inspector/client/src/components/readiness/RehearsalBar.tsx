/**
 * MCPJam's own bar above the copied portal, in MCPJam's style: it says this
 * is a rehearsal and that nothing is sent to the directory, counts what the
 * last run found, holds the server, and starts a run.
 */
import type { ReactNode } from "react";
import { Play, RefreshCw } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@mcpjam/design-system/cn";

/** Directory names as text: no logo is used without permission. */
export const DIRECTORY_NAMES = { claude: "Claude", openai: "ChatGPT" } as const;

export interface RehearsalCounts {
  blockers: number;
  toFix: number;
  likelyFlags: number;
  notChecked: number;
}

const COUNTS = [
  {
    key: "blockers",
    one: "blocker",
    many: "blockers",
    className: "border-destructive/50 text-destructive",
  },
  {
    key: "toFix",
    one: "field to fill",
    many: "fields to fill",
    className: "border-warning/70 text-foreground",
  },
  {
    key: "likelyFlags",
    one: "likely flag",
    many: "likely flags",
    className: "border-dashed border-info/70 text-foreground",
  },
  {
    key: "notChecked",
    one: "not checked",
    many: "not checked",
    className: "border-dashed border-border text-muted-foreground",
  },
] as const;

export function RehearsalBar({
  directory,
  counts,
  server,
  status,
  canRun,
  running,
  hasRun,
  onRun,
}: {
  directory: string;
  /** The last run's totals; `null` before a run has completed. */
  counts: RehearsalCounts | null;
  server: ReactNode;
  status: string;
  canRun: boolean;
  running: boolean;
  hasRun: boolean;
  onRun: () => void;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-muted/40 px-6 py-2.5">
      <p className="flex items-center gap-2 text-sm">
        <span className="rounded-md bg-primary/15 px-2 py-0.5 text-xs font-semibold text-foreground">
          Rehearsal
        </span>
        <span className="text-muted-foreground">
          A copy of the {directory} portal. Nothing here is sent to {directory}.
        </span>
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        {COUNTS.map(({ key, one, many, className }) => {
          const count = counts?.[key] ?? 0;
          return (
            <span
              key={key}
              className={cn(
                "rounded-md border px-2 py-0.5 text-xs tabular-nums",
                className,
                count === 0 && "opacity-60",
              )}
            >
              {counts ? count : "–"} {count === 1 ? one : many}
            </span>
          );
        })}
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-3">
        {server}
        <span className="text-xs text-muted-foreground" role="status">
          {status}
        </span>
        <Button
          type="button"
          size="sm"
          disabled={!canRun || running}
          onClick={onRun}
        >
          {hasRun ? (
            <RefreshCw aria-hidden="true" />
          ) : (
            <Play aria-hidden="true" />
          )}
          {hasRun ? "Run checks again" : "Run checks"}
        </Button>
      </div>
    </div>
  );
}
