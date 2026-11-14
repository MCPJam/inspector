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
import { cn } from "@/lib/utils";

/** Run, disabled with its reason as a tooltip while the suite cannot run. */
export function SuiteRunButton({
  blockedReason,
  busy,
  onRun,
  large = false,
}: {
  blockedReason: string | null;
  busy: boolean;
  onRun: () => void;
  /** The no-runs panel's call to action; the header's is small. */
  large?: boolean;
}) {
  const icon = cn("shrink-0", large ? "size-4" : "h-3.5 w-3.5");
  const button = (
    <Button
      type="button"
      size={large ? "lg" : "sm"}
      className={large ? "gap-2" : "h-8 gap-1.5"}
      disabled={Boolean(blockedReason)}
      aria-label="Run"
      aria-busy={busy}
      title={
        blockedReason ? undefined : "Pick clients, models and iterations, then run"
      }
      onClick={onRun}
    >
      {busy ? (
        <Loader2 className={cn(icon, "animate-spin")} aria-hidden />
      ) : (
        <Play className={icon} aria-hidden />
      )}
      Run
    </Button>
  );
  if (!blockedReason) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{button}</span>
      </TooltipTrigger>
      <TooltipContent variant="muted" side="bottom" className="max-w-[16rem]">
        {blockedReason}
      </TooltipContent>
    </Tooltip>
  );
}

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
  return (
    <div
      className="flex min-w-0 flex-wrap items-start justify-between gap-3"
      data-testid="suite-page-header"
    >
      <div className="min-w-0">
        {/* As tall as the buttons, so the name, pills and buttons share a center. */}
        <div className="flex min-h-8 min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
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
        <SuiteRunButton
          blockedReason={runBlockedReason}
          busy={runBusy}
          onRun={onRun}
        />
      </div>
    </div>
  );
}
