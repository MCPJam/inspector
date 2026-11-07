/**
 * The Suite page's heading row on the new pages: the suite's name and pills,
 * then Export as SDK, Suite settings and Run. Editing lives in Suite
 * settings, so this row only reads the suite and launches it.
 */
import type { ReactNode } from "react";
import { Code2, Loader2, Play, Settings2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { CI_OWNED_REASON_COPY } from "@/lib/evals/is-ci-owned-suite";

/** What the ⓘ beside the history strip's metric labels says. */
export const SUITE_METRIC_HINTS = {
  latency:
    "Wall-clock time of one iteration, start to finish: all its model turns and tool calls, not a single round trip. P50 is the typical iteration; P95, the slowest 1 in 20.",
  tokens: "Tokens the model used per iteration, averaged over the run.",
  toolCalls:
    "Tool calls the model made in the run, added up across every iteration.",
};

/** What the ⓘ beside the runs table's column headers says. */
export const SUITE_COLUMN_HINTS = {
  Latency:
    "Median wall-clock time of one iteration in this run, start to finish: all its model turns and tool calls, not a single round trip.",
  Tokens: "Tokens the model used in this run, added up across every iteration.",
  Calls:
    "Tool calls the model made in this run, added up across every iteration.",
};

/** SuiteDetailOverview's nav layout: links out, and what the header shows. */
export interface SuiteDetailNav {
  /** Opens a launch's representative run; replaces onRunClick. */
  onOpenRun: (runId: string) => void;
  /** Absent for read-only users. */
  onOpenSettings?: () => void;
  onBuildCase?: () => void;
  /** `?importJob=` belongs to Suite settings › Test cases now. */
  onForwardImportJob: (jobId: string) => void;
  /** Model and client of the newest run. */
  pills: ReactNode;
  /** Percent, or null when the suite records none. */
  threshold: number | null;
}

export function SuitePageHeader({
  name,
  pills,
  onExportSdk,
  onOpenSettings,
  ciLocked,
  onDuplicate,
  cancel,
  runBlockedReason,
  runBusy,
  onRun,
}: {
  name: string;
  pills: ReactNode;
  onExportSdk?: () => void;
  onOpenSettings?: () => void;
  ciLocked: boolean;
  onDuplicate?: () => void;
  /** Today's Cancel run button, when a run can be cancelled. */
  cancel: ReactNode;
  runBlockedReason: string | null;
  runBusy: boolean;
  onRun: () => void;
}) {
  const runButton = (
    <Button
      type="button"
      size="sm"
      className="h-8 gap-1.5"
      disabled={Boolean(runBlockedReason)}
      aria-label="Run"
      aria-busy={runBusy}
      title={
        runBlockedReason
          ? undefined
          : "Pick clients, models and iterations, then run"
      }
      onClick={onRun}
    >
      {runBusy ? (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
      ) : (
        <Play className="h-3.5 w-3.5 shrink-0" aria-hidden />
      )}
      Run
    </Button>
  );
  return (
    <div
      className="flex min-w-0 flex-wrap items-start justify-between gap-3"
      data-testid="suite-page-header"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
        <h2 className="truncate text-xl font-semibold tracking-tight text-foreground">
          {name}
        </h2>
        {pills}
      </div>
      <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">
        {ciLocked ? (
          <span
            className="text-xs text-muted-foreground"
            data-testid="suite-detail-ci-owned"
          >
            {CI_OWNED_REASON_COPY}
          </span>
        ) : null}
        {ciLocked && onDuplicate ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8"
            onClick={onDuplicate}
            data-testid="suite-detail-duplicate-to-edit"
          >
            Duplicate to edit
          </Button>
        ) : null}
        {onExportSdk ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-1.5"
            onClick={onExportSdk}
          >
            <Code2 className="size-3.5" aria-hidden />
            Export as SDK
          </Button>
        ) : null}
        {onOpenSettings ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-1.5"
            onClick={onOpenSettings}
          >
            <Settings2 className="size-3.5" aria-hidden />
            Suite settings
          </Button>
        ) : null}
        {cancel}
        {runBlockedReason ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">{runButton}</span>
            </TooltipTrigger>
            <TooltipContent
              variant="muted"
              side="bottom"
              className="max-w-[16rem]"
            >
              {runBlockedReason}
            </TooltipContent>
          </Tooltip>
        ) : (
          runButton
        )}
      </div>
    </div>
  );
}
