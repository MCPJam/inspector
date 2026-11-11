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

export function SuitePageHeader({
  name,
  pills,
  review,
  onExportSdk,
  onOpenSettings,
  ciLocked,
  onDuplicate,
  cancel,
  runBlockedReason,
  runBusy,
  onRun,
  runsAs,
}: {
  name: string;
  pills: ReactNode;
  /** Today's "Review N draft cases", until imports move to Suite settings. */
  review?: ReactNode;
  onExportSdk?: () => void;
  /** Absent for readers who cannot edit the suite. */
  onOpenSettings?: () => void;
  ciLocked: boolean;
  onDuplicate?: () => void;
  /** Today's Cancel run button, when a run can be cancelled. */
  cancel: ReactNode;
  runBlockedReason: string | null;
  runBusy: boolean;
  onRun: () => void;
  /** "Runs as you · …" under the name, when the suite's accounts are chosen. */
  runsAs?: ReactNode;
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
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
          <h2 className="truncate text-xl font-semibold tracking-tight text-foreground">
            {name}
          </h2>
          {pills}
        </div>
        {runsAs}
      </div>
      <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">
        {review}
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
