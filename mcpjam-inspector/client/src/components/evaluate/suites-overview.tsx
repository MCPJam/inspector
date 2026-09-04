import { useMemo, type MouseEvent } from "react";
import { formatDistanceToNow } from "date-fns";
import { AlertTriangle, Loader2, Trash2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { resolveHostLogoByName } from "@/lib/host-logo";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { cn } from "@/lib/utils";
import { getEffectiveSuiteServers } from "../evals/helpers";
import type { EvalSuite, EvalSuiteOverviewEntry, EvalSuiteRun } from "../evals/types";

interface SuitesOverviewProps {
  overview: EvalSuiteOverviewEntry[];
  onSelectSuite: (id: string) => void;
  onRerun: (suite: EvalSuite) => void;
  onCancelRun: (runId: string) => void;
  /**
   * Deleting from the landing row is the only path that does not require
   * opening the suite first. The in-suite path (Edit → settings → Delete)
   * still exists; this is the one that works for a suite you never want to
   * look at again, including one that has never run.
   */
  onDelete?: (suite: EvalSuite) => void;
  /** Per-suite: creators and project admins only. Hides the control entirely. */
  canDeleteSuite?: (suite: EvalSuite) => boolean;
  rerunningSuiteId?: string | null;
  cancellingRunId?: string | null;
  deletingSuiteId?: string | null;
}

// Shared with User Testing's scenario list so the two landings read as one
// product. Data cells use the same pad + cols; the trailing action column is
// extra so Run/Cancel don't steal space from Suite/Client/Server.
const ROW_PAD = "flex w-full items-center gap-4 px-3";
const DATA_COLS =
  "grid min-w-0 flex-1 items-center gap-4 grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_5rem_7rem]";
const ACTION_COL = "flex w-[7.5rem] shrink-0 items-center justify-end gap-1";

export function SuitesOverview(props: SuitesOverviewProps) {
  return (
    <ErrorBoundary
      fallback={
        <div
          className="flex flex-col items-center justify-center px-6 py-16 text-center"
          data-testid="evals-suites-overview-error"
        >
          <AlertTriangle className="size-8 text-amber-500" />
          <h2 className="mt-4 text-base font-semibold">
            Couldn&apos;t show your suites
          </h2>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            The list failed to render. Reload the page — this doesn&apos;t mean
            anything happened to your suites.
          </p>
        </div>
      }
    >
      <OverviewBody {...props} />
    </ErrorBoundary>
  );
}

function OverviewBody({
  overview,
  onSelectSuite,
  onRerun,
  onCancelRun,
  onDelete,
  canDeleteSuite,
  rerunningSuiteId = null,
  cancellingRunId = null,
  deletingSuiteId = null,
}: SuitesOverviewProps) {
  const themeMode = usePreferencesStore((s) => s.themeMode);

  const sortedOverview = useMemo(
    () =>
      [...overview].sort((a, b) => {
        const aTime = latestActivityAt(a);
        const bTime = latestActivityAt(b);
        return bTime - aTime;
      }),
    [overview],
  );

  if (sortedOverview.length === 0) {
    return null;
  }

  return (
    <div className="min-w-0" data-testid="evals-suites-overview">
      <div
        className={cn(
          ROW_PAD,
          "border-b border-border/40 pb-2 text-xs font-medium text-muted-foreground",
        )}
      >
        <div className={DATA_COLS}>
          <span>Suite</span>
          <span>Client</span>
          <span>Server</span>
          <span className="text-right">Pass rate</span>
          <span className="text-right">Last run</span>
        </div>
        <span className={ACTION_COL} aria-hidden />
      </div>
      <ul className="mt-1">
        {sortedOverview.map((entry) => (
          <li key={entry.suite._id}>
            <div
              className={cn(
                ROW_PAD,
                "rounded-md border border-transparent py-3 transition-colors",
                "hover:border-border/60 hover:bg-muted/40",
              )}
            >
              <button
                type="button"
                data-testid="evals-suites-overview-row"
                data-suite-id={entry.suite._id}
                onClick={() => onSelectSuite(entry.suite._id)}
                className={cn(
                  DATA_COLS,
                  "text-left",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                )}
              >
                <span className="min-w-0 truncate text-sm font-medium text-foreground">
                  {entry.suite.name || "Untitled suite"}
                </span>
                <ClientCell suite={entry.suite} themeMode={themeMode} />
                <span className="min-w-0 truncate text-sm text-muted-foreground">
                  {serverLabel(entry.suite)}
                </span>
                <span
                  data-testid="evals-suites-overview-pass-rate"
                  className="text-right text-sm tabular-nums text-foreground"
                >
                  {passRateLabel(entry)}
                </span>
                <span className="truncate text-right text-sm text-muted-foreground">
                  {lastRunLabel(entry)}
                </span>
              </button>
              <div className={ACTION_COL}>
                <RowRunControl
                  suite={entry.suite}
                  latestRun={entry.latestRun}
                  onRerun={onRerun}
                  onCancelRun={onCancelRun}
                  rerunningSuiteId={rerunningSuiteId}
                  cancellingRunId={cancellingRunId}
                />
                {onDelete && (canDeleteSuite?.(entry.suite) ?? true) ? (
                  <RowDeleteControl
                    suite={entry.suite}
                    onDelete={onDelete}
                    deletingSuiteId={deletingSuiteId}
                  />
                ) : null}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function stopRowClick(event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
}

function RowRunControl({
  suite,
  latestRun,
  onRerun,
  onCancelRun,
  rerunningSuiteId,
  cancellingRunId,
}: {
  suite: EvalSuite;
  latestRun: EvalSuiteRun | null;
  onRerun: (suite: EvalSuite) => void;
  onCancelRun: (runId: string) => void;
  rerunningSuiteId: string | null;
  cancellingRunId: string | null;
}) {
  const suiteTitle = suite.name || "Untitled suite";
  const hasServers = getEffectiveSuiteServers(suite).length > 0;
  const latestRunInProgress =
    latestRun?.status === "running" || latestRun?.status === "pending";
  const isStarting = rerunningSuiteId === suite._id && !latestRunInProgress;
  const isCancelling = Boolean(
    latestRun && cancellingRunId === latestRun._id,
  );

  if (latestRunInProgress && latestRun) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 px-2.5"
        data-testid="evals-suites-overview-cancel"
        aria-label={`Cancel run for ${suiteTitle}`}
        disabled={isCancelling}
        onClick={(event) => {
          stopRowClick(event);
          onCancelRun(latestRun._id);
        }}
      >
        {isCancelling ? (
          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden />
        ) : null}
        Cancel
      </Button>
    );
  }

  if (isStarting) {
    return (
      <Button
        type="button"
        variant="default"
        size="sm"
        className="h-7 px-2.5"
        data-testid="evals-suites-overview-running"
        aria-label={`Running ${suiteTitle}`}
        disabled
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
      </Button>
    );
  }

  return (
    <Button
      type="button"
      variant="default"
      size="sm"
      className="h-7 px-2.5"
      data-testid="evals-suites-overview-run"
      aria-label={hasServers ? `Run ${suiteTitle}` : "No servers configured"}
      title={hasServers ? undefined : "No servers configured"}
      disabled={!hasServers}
      onClick={(event) => {
        stopRowClick(event);
        onRerun(suite);
      }}
    >
      Run
    </Button>
  );
}

function RowDeleteControl({
  suite,
  onDelete,
  deletingSuiteId,
}: {
  suite: EvalSuite;
  onDelete: (suite: EvalSuite) => void;
  deletingSuiteId: string | null;
}) {
  const isDeleting = deletingSuiteId === suite._id;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 w-7 p-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
      data-testid="evals-suites-overview-delete"
      aria-label={`Delete ${suite.name || "Untitled suite"}`}
      disabled={isDeleting}
      onClick={(event) => {
        stopRowClick(event);
        // Confirmation is the caller's: `EvalsTab` arms `ConfirmationDialogs`,
        // which is the same dialog every other delete path in evals uses.
        onDelete(suite);
      }}
    >
      {isDeleting ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
      ) : (
        <Trash2 className="h-3.5 w-3.5" aria-hidden />
      )}
    </Button>
  );
}

function ClientCell({
  suite,
  themeMode,
}: {
  suite: EvalSuite;
  themeMode: "light" | "dark";
}) {
  const attachments = suite.hostAttachments ?? [];
  if (attachments.length === 0) {
    return <span className="text-sm text-muted-foreground">—</span>;
  }

  const name = attachments[0].hostName?.trim() || attachments[0].namedHostId;
  const extra = attachments.length - 1;
  const logoSrc = resolveHostLogoByName(name, themeMode);

  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="inline-flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border/50 bg-background">
        {logoSrc ? (
          <img
            src={logoSrc}
            alt=""
            className="size-3.5 object-contain"
          />
        ) : (
          <span
            aria-hidden
            className="text-[8px] font-semibold uppercase text-muted-foreground"
          >
            {name.slice(0, 2)}
          </span>
        )}
      </span>
      <span className="min-w-0 truncate text-sm text-foreground">{name}</span>
      {extra > 0 ? (
        <span className="shrink-0 text-sm text-muted-foreground">+{extra}</span>
      ) : null}
    </span>
  );
}

function latestActivityAt(entry: EvalSuiteOverviewEntry): number {
  return (
    entry.suite.updatedAt ??
    entry.latestRun?.completedAt ??
    entry.latestRun?.createdAt ??
    entry.suite._creationTime ??
    0
  );
}

function serverLabel(suite: EvalSuite): string {
  const names = getEffectiveSuiteServers(suite);
  if (names.length > 0) return names[0];
  return "—";
}

function passRateLabel(entry: EvalSuiteOverviewEntry): string {
  const rate = entry.latestRun?.summary?.passRate;
  if (typeof rate !== "number") return "—";
  return `${Math.round(rate * 100)}%`;
}

function lastRunLabel(entry: EvalSuiteOverviewEntry): string {
  const timestamp =
    entry.latestRun?.completedAt ?? entry.latestRun?.createdAt ?? null;
  if (!timestamp) return "—";
  return formatDistanceToNow(timestamp, { addSuffix: true });
}
