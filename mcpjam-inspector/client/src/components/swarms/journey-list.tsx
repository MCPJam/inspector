import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, usePaginatedQuery } from "convex/react";
import { Info } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import {
  SWARM_QUERIES,
  DEFAULT_PAGE_SIZE,
  type JourneyRun,
  type JourneyRollup,
} from "@/lib/swarm-api";
import { useProjectServerAttachments } from "@/hooks/useViews";
import { JourneyHostLogoMark } from "./journey-host-logo";
import {
  formatJourneyRelativeTime,
  runNumberLabel,
  runStatusChipClass,
  runSummaryLine,
} from "./journey-run-format";

// Structural view of the SwarmsTab `Journey` / `HostItem` shapes — kept local so
// this module stays decoupled from the surface component (no import cycle).
export type JourneyListJourney = {
  _id: string;
  personaRefId: string;
  name?: string;
  goal: string;
  hostIds: string[];
  serverAttachmentId?: string | null;
  config: { sessionsPerHost: number; maxTurns: number };
};
export type JourneyListHost = { hostId: string; name: string };
type ServerAttachment = { _id: string; name: string };

/** The run currently open in the surface's detail panel. */
export type JourneyRunSelection = {
  journeyId: string;
  runId: string;
  hostId: string | null;
};

export type JourneyCellOutcome = "pass" | "fail" | "part" | "running" | "none";

const CELL_STATUS_META: Record<
  Exclude<JourneyCellOutcome, "none">,
  { label: string; dot: string; text: string }
> = {
  pass: { label: "Pass", dot: "bg-success", text: "text-success" },
  fail: { label: "Fail", dot: "bg-destructive", text: "text-destructive" },
  part: {
    label: "Partial",
    dot: "bg-amber-500",
    text: "text-amber-600 dark:text-amber-400",
  },
  running: {
    label: "Running",
    dot: "bg-muted-foreground animate-pulse",
    text: "text-muted-foreground",
  },
};

/** Trend-segment fills — same palette as the evals RunTrendStrip. */
const SEGMENT_CLASS: Record<Exclude<JourneyCellOutcome, "none">, string> = {
  pass: "bg-success/70",
  fail: "bg-destructive/70",
  part: "bg-amber-500/70 dark:bg-amber-400/70",
  running: "bg-warning/50 animate-pulse",
};

/** Run-level status dot for the run rows (status string, not per-host). */
function runStatusDotClass(status: string): string {
  switch (status) {
    case "completed":
      return "bg-success";
    case "failed":
      return "bg-destructive";
    case "partial":
    case "rate_limited":
      return "bg-amber-500";
    case "stale":
      return "bg-muted-foreground/50";
    default:
      return "bg-muted-foreground animate-pulse"; // running
  }
}

const MAX_TREND_SEGMENTS = 12;

/**
 * The journeys' target hosts, ordered by the project `hosts` array with any
 * hosts not in that list appended in first-seen order. Names fall back to a
 * truncated id.
 */
export function journeyHostColumns(
  journeys: JourneyListJourney[],
  hosts: JourneyListHost[],
): JourneyListHost[] {
  const targeted = new Set<string>();
  for (const j of journeys) for (const id of j.hostIds) targeted.add(id);

  const ordered: string[] = [];
  for (const h of hosts) {
    if (targeted.has(h.hostId) && !ordered.includes(h.hostId)) {
      ordered.push(h.hostId);
    }
  }
  for (const j of journeys) {
    for (const id of j.hostIds) {
      if (!ordered.includes(id)) ordered.push(id);
    }
  }

  const nameOf = (id: string) =>
    hosts.find((h) => h.hostId === id)?.name ?? id.slice(0, 8);
  return ordered.map((id) => ({ hostId: id, name: nameOf(id) }));
}

/** Per-(run, host) outcome from the run's host rollup summary. */
export function journeyHostOutcome(
  run: JourneyRun,
  hostId: string,
): JourneyCellOutcome {
  const entry = run.hostSummaries.find((h) => h.hostId === hostId);
  if (!entry || entry.total === 0) {
    return run.status === "running" ? "running" : "none";
  }
  const done = entry.succeeded + entry.failed + entry.rateLimited;
  if (run.status === "running" && done < entry.total) return "running";
  if (entry.succeeded === entry.total) return "pass";
  if (entry.succeeded === 0) return "fail";
  return "part";
}

function hostSummaryFor(run: JourneyRun, hostId: string) {
  return run.hostSummaries.find((h) => h.hostId === hostId) ?? null;
}

/** Per-journey blocks: each journey shows its own hosts as result cells. */
export function JourneyList({
  journeys,
  hosts,
  isAuthenticated,
  projectId,
  onLaunch,
  initialRunId,
  selection,
  onOpenRun,
  onCloseRun,
}: {
  journeys: JourneyListJourney[];
  hosts: JourneyListHost[];
  isAuthenticated: boolean;
  projectId: string;
  onLaunch: (
    journeyId: string,
  ) => Promise<
    { status: "launched"; runId?: string } | { status: "already_launching" }
  >;
  initialRunId?: string;
  selection: JourneyRunSelection | null;
  /** Open a run in the surface's detail panel (optionally focused on a host). */
  onOpenRun: (
    journey: JourneyListJourney,
    run: JourneyRun,
    hostId: string | null,
  ) => void;
  onCloseRun: () => void;
}) {
  const { serverAttachments } = useProjectServerAttachments({
    isAuthenticated,
    projectId,
  });

  return (
    <div className="flex flex-col gap-3">
      {journeys.map((journey) => (
        <JourneyBlock
          key={journey._id}
          journey={journey}
          hosts={hosts}
          serverAttachments={serverAttachments}
          onLaunch={onLaunch}
          initialRunId={initialRunId}
          selection={selection?.journeyId === journey._id ? selection : null}
          onOpenRun={onOpenRun}
          onCloseRun={onCloseRun}
        />
      ))}
    </div>
  );
}

function JourneyBlock({
  journey,
  hosts,
  serverAttachments,
  onLaunch,
  initialRunId,
  selection,
  onOpenRun,
  onCloseRun,
}: {
  journey: JourneyListJourney;
  hosts: JourneyListHost[];
  serverAttachments: ServerAttachment[];
  onLaunch: (
    journeyId: string,
  ) => Promise<
    { status: "launched"; runId?: string } | { status: "already_launching" }
  >;
  initialRunId?: string;
  /** Non-null only when the open run belongs to THIS journey. */
  selection: JourneyRunSelection | null;
  onOpenRun: (
    journey: JourneyListJourney,
    run: JourneyRun,
    hostId: string | null,
  ) => void;
  onCloseRun: () => void;
}) {
  const {
    results: runs,
    status: runsStatus,
    loadMore,
  } = usePaginatedQuery(
    SWARM_QUERIES.listJourneyRuns as any,
    { journeyRefId: journey._id } as any,
    { initialNumItems: DEFAULT_PAGE_SIZE },
  );
  const rollup = useQuery(
    SWARM_QUERIES.journeyRollup as any,
    { journeyRefId: journey._id } as any,
  ) as JourneyRollup | undefined;

  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);

  const typedRuns = runs as JourneyRun[];
  const latestRun = typedRuns[0] ?? null;
  const runCount = rollup?.runCount ?? typedRuns.length;
  const hostCols = useMemo(
    () => journeyHostColumns([journey], hosts),
    [journey, hosts],
  );
  const serverGroupName = journey.serverAttachmentId
    ? (serverAttachments.find((a) => a._id === journey.serverAttachmentId)
        ?.name ?? null)
    : null;
  const configHint = `${journey.config.sessionsPerHost}/host · ${journey.config.maxTurns} turns`;

  // Deep-link restore: open the linked run in the detail panel. Runs once.
  const appliedInitialRunRef = useRef(false);
  useEffect(() => {
    if (appliedInitialRunRef.current || !initialRunId) return;
    const match = typedRuns.find((r) => r._id === initialRunId);
    if (match) {
      appliedInitialRunRef.current = true;
      onOpenRun(journey, match, null);
    }
  }, [initialRunId, typedRuns, journey, onOpenRun]);

  const onRun = async () => {
    if (launching) return;
    setLaunchError(null);
    setLaunching(true);
    try {
      const result = await onLaunch(journey._id);
      if (result.status === "already_launching") return;
      toast.success("Journey run started");
    } catch (e) {
      setLaunchError(e instanceof Error ? e.message : "Failed to start run");
    } finally {
      setLaunching(false);
    }
  };

  const openRun = (run: JourneyRun, hostId: string | null) => {
    if (selection?.runId === run._id && selection.hostId === hostId) {
      onCloseRun();
      return;
    }
    onOpenRun(journey, run, hostId);
  };

  return (
    <div
      className={cn(
        "rounded-lg border px-3 py-2.5",
        selection ? "border-primary/50" : "border-border/60",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <p
          className="min-w-0 flex-1 truncate text-sm font-medium"
          title={journey.goal}
        >
          {journey.goal}
        </p>
        <Button
          type="button"
          size="sm"
          className="h-7 shrink-0 px-2.5 text-xs"
          disabled={launching}
          onClick={onRun}
        >
          {launching ? "Starting…" : "Run"}
        </Button>
      </div>

      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
        <span>
          {runCount} run{runCount === 1 ? "" : "s"}
        </span>
        {latestRun ? (
          <>
            <span aria-hidden>·</span>
            <span>latest:</span>
            <span
              className={cn(
                "rounded-full px-1.5 py-px text-[10px] font-medium capitalize",
                runStatusChipClass(latestRun.status),
              )}
            >
              {latestRun.status.replace(/_/g, " ")}
            </span>
            <span>{formatJourneyRelativeTime(latestRun.createdAt)}</span>
          </>
        ) : null}
        {serverGroupName ? (
          <>
            <span aria-hidden>·</span>
            <span className="truncate">{serverGroupName}</span>
          </>
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Journey config"
              className="rounded-full p-0.5 text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Info className="size-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-[220px]">
            <p className="text-xs leading-snug">{configHint}</p>
          </TooltipContent>
        </Tooltip>
      </div>

      {launchError ? (
        <p className="mt-2 rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-xs text-red-600 dark:text-red-400">
          {launchError}
        </p>
      ) : null}

      {/* One result cell per targeted host — latest outcome + clickable run trend. */}
      <div className="mt-2.5 grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-1.5">
        {hostCols.map((col) => {
          if (!latestRun) {
            return (
              <div
                key={col.hostId}
                data-testid="journey-cell-empty"
                className="flex min-h-[4rem] flex-col items-start justify-center gap-1 rounded-md border border-dashed border-border/50 bg-muted/5 px-2.5 py-2"
              >
                <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
                  <JourneyHostLogoMark label={col.name} />
                  <span className="truncate text-[11px] font-medium text-foreground/80">
                    {col.name}
                  </span>
                </span>
                <span className="text-[11px] text-muted-foreground">
                  Not run
                </span>
              </div>
            );
          }

          const outcome = journeyHostOutcome(latestRun, col.hostId);
          const meta = outcome === "none" ? null : CELL_STATUS_META[outcome];
          const summary = hostSummaryFor(latestRun, col.hostId);
          // Oldest → newest, capped like the evals trend strip.
          const trendRuns = [...typedRuns]
            .reverse()
            .map((r) => ({
              run: r,
              outcome: journeyHostOutcome(r, col.hostId),
            }))
            .filter(
              (
                p,
              ): p is {
                run: JourneyRun;
                outcome: Exclude<JourneyCellOutcome, "none">;
              } => p.outcome !== "none",
            )
            .slice(-MAX_TREND_SEGMENTS);
          const cellSelected =
            selection?.runId === latestRun._id &&
            selection.hostId === col.hostId;

          return (
            <div
              key={col.hostId}
              className={cn(
                "flex min-h-[4rem] w-full flex-col items-start justify-center gap-1 rounded-md border px-2.5 py-2 text-left transition-colors",
                cellSelected
                  ? "border-primary bg-primary/5"
                  : "border-border/50 bg-background/60",
              )}
            >
              <button
                type="button"
                data-testid="journey-host-cell"
                data-outcome={outcome}
                aria-label={`Open runs for ${journey.goal} on ${col.name}`}
                title={
                  summary
                    ? `Latest run on ${col.name}: ${summary.succeeded}/${summary.total} sessions ok`
                    : undefined
                }
                onClick={() => openRun(latestRun, col.hostId)}
                className="flex w-full min-w-0 items-center justify-between gap-1.5 rounded-sm outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <JourneyHostLogoMark label={col.name} />
                  <span className="truncate text-[11px] font-medium text-foreground/80">
                    {col.name}
                  </span>
                </span>
                <span className="inline-flex shrink-0 items-center gap-1.5">
                  {meta ? (
                    <span className={cn("size-1.5 rounded-full", meta.dot)} />
                  ) : null}
                  <span
                    className={cn(
                      "text-[11px] font-semibold tabular-nums",
                      meta?.text ?? "text-muted-foreground",
                    )}
                  >
                    {summary
                      ? `${summary.succeeded}/${summary.total} ok`
                      : (meta?.label ?? "No data")}
                  </span>
                </span>
              </button>
              {trendRuns.length > 0 ? (
                <div
                  className="flex h-4 w-full items-stretch gap-[2px]"
                  data-testid="journey-trend-strip"
                >
                  {trendRuns.map(({ run, outcome: segOutcome }) => (
                    <button
                      key={run._id}
                      type="button"
                      aria-label={`Open run ${run.status} (${runSummaryLine(run)}) on ${col.name}`}
                      title={`${runNumberLabel(runCount, typedRuns.indexOf(run))} · ${run.status.replace(/_/g, " ")} · ${runSummaryLine(run)} · ${formatJourneyRelativeTime(run.createdAt)}`}
                      onClick={() => openRun(run, col.hostId)}
                      className={cn(
                        "min-w-[4px] flex-1 rounded-[2px] outline-none transition-opacity hover:opacity-70 focus-visible:ring-2 focus-visible:ring-ring",
                        SEGMENT_CLASS[segOutcome],
                        selection?.runId === run._id &&
                          "ring-1 ring-primary ring-offset-1 ring-offset-background",
                      )}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {/* Run history — visible while one of this journey's runs is open. */}
      {selection ? (
        <div className="mt-2 space-y-0.5 border-t border-border/40 pt-2">
          <p className="px-1.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Runs
          </p>
          {typedRuns.map((r, index) => {
            const isOpen = selection.runId === r._id;
            return (
              <button
                key={r._id}
                type="button"
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-xs outline-none transition-colors",
                  "hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring",
                  isOpen && "bg-muted/40",
                )}
                aria-expanded={isOpen}
                aria-label={
                  isOpen
                    ? `Hide sessions for run ${r.status}`
                    : `View sessions for run ${r.status}`
                }
                onClick={() => (isOpen ? onCloseRun() : openRun(r, null))}
              >
                <span
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    runStatusDotClass(r.status),
                  )}
                />
                <span className="shrink-0 font-medium text-foreground/90">
                  {runNumberLabel(runCount, index)}
                </span>
                <span className="capitalize text-muted-foreground">
                  {r.status.replace(/_/g, " ")}
                </span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {runSummaryLine(r)}
                </span>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {formatJourneyRelativeTime(r.createdAt)}
                </span>
              </button>
            );
          })}
          {runsStatus === "CanLoadMore" ? (
            <button
              type="button"
              className="mt-0.5 px-1.5 text-[11px] font-medium text-primary hover:underline"
              onClick={() => loadMore(DEFAULT_PAGE_SIZE)}
            >
              Load more runs
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
