/**
 * Dedicated Swarm Run (wave) detail at `/swarms/:swarmId`.
 *
 * Chrome matches the product mock: back to Swarms, title + absolute time,
 * Share / Run again, then Overview · Insights · Sessions · Personas scoped
 * to this wave — not the list-level view modes.
 */
import { useCallback, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { Loader2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { ScrollArea } from "@mcpjam/design-system/scroll-area";
import { ViewModeSelector } from "@/components/shared/view-mode-selector";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import {
  buildSwarmPath,
  parseSwarmDetailTab,
  routePaths,
  useAppNavigate,
  type SwarmDetailTab,
} from "@/lib/app-navigation";
import { getShareableAppOrigin } from "@/lib/chatbox-session";
import { SWARM_QUERIES, type SwarmOverview } from "@/lib/swarm-api";
import { shouldQueryProjectId } from "@/hooks/useProjects";
import { formatSwarmAbsoluteTime } from "@/components/swarms/journey-run-format";
import { SwarmsSessionsPanel } from "@/components/swarms/SwarmsSessionsPanel";
import {
  formatPercent,
  groupRunsIntoSwarmWaves,
  previousScoreByWaveId,
  resolveSwarmWave,
  scoreChangePoints,
  swarmWaveRouteId,
  swarmWaveTitle,
  SwarmWaveFindingsList,
  waveScoreRate,
  waveSessionTotals,
  waveStatusDotClass,
  type SwarmWave,
} from "@/components/swarms/swarm-overview-panel";

const DETAIL_TAB_OPTIONS = [
  { value: "overview" as const, label: "Overview" },
  { value: "insights" as const, label: "Insights" },
  { value: "sessions" as const, label: "Sessions" },
  { value: "personas" as const, label: "Personas" },
] as const;

export interface SwarmRunDetailProps {
  swarmId: string;
  projectId: string | null;
  personas: ReadonlyArray<{ _id: string; name: string; role?: string }>;
  hosts?: ReadonlyArray<{ hostId: string; name: string }>;
  /**
   * Relaunch each non-archived journey in the wave. Parent owns the launch
   * coordinator (idempotency / quota). Returns after all launches settle.
   */
  onRunAgain: (journeyRefIds: string[]) => Promise<void>;
  /** Jump to list Personas with this persona selected. */
  onOpenPersona: (personaName: string) => void;
}

export function SwarmRunDetail({
  swarmId,
  projectId,
  personas,
  hosts = [],
  onRunAgain,
  onOpenPersona,
}: SwarmRunDetailProps) {
  const navigate = useAppNavigate();
  const [tab, setTab] = useState<SwarmDetailTab>(() =>
    parseSwarmDetailTab(
      typeof window !== "undefined" ? window.location.search : ""
    )
  );
  const [sessionsPersonaFilter, setSessionsPersonaFilter] = useState<
    string | null
  >(null);
  const [drilldownThreadId, setDrilldownThreadId] = useState<string | null>(
    null
  );
  const [runAgainBusy, setRunAgainBusy] = useState(false);

  const queryable = shouldQueryProjectId(projectId);
  const overview = useQuery(
    SWARM_QUERIES.getSwarmOverview as any,
    (queryable ? { projectId } : "skip") as any
  ) as SwarmOverview | undefined;

  const waves = useMemo(
    () => groupRunsIntoSwarmWaves(overview?.runs ?? []),
    [overview]
  );
  const previousScores = useMemo(() => previousScoreByWaveId(waves), [waves]);
  const wave = useMemo(
    () => (overview === undefined ? null : resolveSwarmWave(waves, swarmId)),
    [overview, waves, swarmId]
  );

  const handleTabChange = useCallback(
    (next: SwarmDetailTab) => {
      setTab(next);
      navigate(buildSwarmPath(swarmId, next), { replace: true });
    },
    [navigate, swarmId]
  );

  const handleShare = useCallback(async () => {
    const url = `${getShareableAppOrigin()}${buildSwarmPath(swarmId, tab)}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied");
    } catch {
      toast.error("Could not copy link");
    }
  }, [swarmId, tab]);

  const handleOpenSession = useCallback((sessionId: string) => {
    setDrilldownThreadId(sessionId);
    setTab("sessions");
    navigate(buildSwarmPath(swarmId, "sessions"), { replace: true });
  }, [navigate, swarmId]);

  const launchableJourneyIds = useMemo(() => {
    if (!wave) return [];
    return [
      ...new Set(
        wave.runs
          .filter((r) => !r.journeyArchived)
          .map((r) => r.journeyRefId)
      ),
    ];
  }, [wave]);

  const handleRunAgain = useCallback(async () => {
    if (launchableJourneyIds.length === 0) return;
    setRunAgainBusy(true);
    try {
      await onRunAgain(launchableJourneyIds);
      toast.success(
        launchableJourneyIds.length === 1
          ? "Swarm run started"
          : `Started ${launchableJourneyIds.length} goals`
      );
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not start swarm run"
      );
    } finally {
      setRunAgainBusy(false);
    }
  }, [launchableJourneyIds, onRunAgain]);

  if (overview === undefined) {
    return (
      <div
        className="flex h-full min-h-0 flex-col"
        data-testid="swarm-run-detail"
      >
        <DetailBackLink onBack={() => navigate(routePaths.swarms)} />
        <div
          className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"
          data-testid="swarm-run-detail-loading"
        >
          <Loader2 className="size-4 animate-spin" />
          Loading swarm…
        </div>
      </div>
    );
  }

  if (!wave) {
    return (
      <div
        className="flex h-full min-h-0 flex-col"
        data-testid="swarm-run-detail"
      >
        <DetailBackLink onBack={() => navigate(routePaths.swarms)} />
        <div
          className="flex flex-1 flex-col items-center justify-center gap-3 px-6"
          data-testid="swarm-run-detail-missing"
        >
          <p className="text-sm font-semibold text-foreground">
            Swarm run not found
          </p>
          <p className="max-w-sm text-center text-xs text-muted-foreground">
            This link may be from another project, or the run is outside the
            overview window.
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => navigate(routePaths.swarms)}
          >
            Back to Swarms
          </Button>
        </div>
      </div>
    );
  }

  const title = swarmWaveTitle(wave.runs);
  const previousRate = previousScores.get(wave.waveId) ?? null;
  const rate = waveScoreRate(wave.runs);
  const change = scoreChangePoints(rate, previousRate);
  const sessions = waveSessionTotals(wave.runs);
  const runIds = wave.runs.map((r) => r.runId);
  const runLabels = new Map(
    wave.runs.map((r) => [r.runId, `${r.personaName} · ${r.journeyName}`])
  );

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="swarm-run-detail"
      data-swarm-id={swarmWaveRouteId(wave)}
    >
      <div className="relative shrink-0 space-y-3 border-b border-border/40 px-8 py-4">
        <DetailBackLink onBack={() => navigate(routePaths.swarms)} />

        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
              <h1
                className="truncate text-xl font-bold tracking-tight text-foreground"
                data-testid="swarm-run-detail-title"
              >
                {title}
              </h1>
              <span
                className="shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground"
                data-testid="swarm-run-detail-time"
              >
                {formatSwarmAbsoluteTime(wave.createdAt)}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="rounded-lg"
              onClick={() => void handleShare()}
              data-testid="swarm-run-detail-share"
            >
              Share
            </Button>
            <Button
              type="button"
              size="sm"
              className="rounded-lg font-medium"
              disabled={runAgainBusy || launchableJourneyIds.length === 0}
              onClick={() => void handleRunAgain()}
              data-testid="swarm-run-detail-run-again"
            >
              {runAgainBusy ? (
                <Loader2 className="mr-1.5 size-3.5 animate-spin" />
              ) : null}
              Run again
            </Button>
          </div>
        </div>

        <ViewModeSelector
          value={tab}
          ariaLabel="Swarm run view"
          indicatorId="swarm-run-detail"
          onChange={handleTabChange}
          options={DETAIL_TAB_OPTIONS}
          className="justify-start md:w-auto"
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {tab === "overview" ? (
          <DetailOverview
            wave={wave}
            rate={rate}
            change={change}
            sessions={sessions}
          />
        ) : null}
        {tab === "insights" ? (
          <ScrollArea className="min-h-0 flex-1">
            <div className="px-8 py-5">
              <SwarmWaveFindingsList
                runs={wave.runs}
                onOpenSession={handleOpenSession}
              />
            </div>
          </ScrollArea>
        ) : null}
        {tab === "sessions" && projectId ? (
          <SwarmsSessionsPanel
            projectId={projectId}
            personas={personas}
            hosts={hosts}
            personaRefId={sessionsPersonaFilter}
            onPersonaRefIdChange={setSessionsPersonaFilter}
            initialThreadId={drilldownThreadId}
            runLabels={runLabels}
            journeyRunIds={runIds}
          />
        ) : null}
        {tab === "sessions" && !projectId ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Sign in to browse sessions.
          </div>
        ) : null}
        {tab === "personas" ? (
          <DetailPersonas wave={wave} onOpenPersona={onOpenPersona} />
        ) : null}
      </div>
    </div>
  );
}

function DetailBackLink({ onBack }: { onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      className="text-sm font-medium text-primary hover:underline"
      data-testid="swarm-run-detail-back"
    >
      ← Swarms
    </button>
  );
}

function DetailOverview({
  wave,
  rate,
  change,
  sessions,
}: {
  wave: SwarmWave;
  rate: number | null;
  change: number | null;
  sessions: { succeeded: number; total: number };
}) {
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col gap-6 px-8 py-5" data-testid="swarm-run-detail-overview">
        <div className="flex flex-wrap items-center gap-6">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "size-2.5 rounded-full",
                waveStatusDotClass(wave.runs)
              )}
              aria-hidden
            />
            <span className="text-sm text-muted-foreground">
              {sessions.succeeded}/{sessions.total} sessions
            </span>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Score
            </p>
            <p
              className="text-2xl font-semibold tabular-nums"
              data-testid="swarm-run-detail-score"
            >
              {rate != null ? formatPercent(rate) : "—"}
            </p>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Change
            </p>
            <p
              className={cn(
                "text-2xl font-semibold tabular-nums",
                change == null
                  ? "text-muted-foreground"
                  : change > 0
                    ? "text-emerald-600 dark:text-emerald-400"
                    : change < 0
                      ? "text-red-600 dark:text-red-400"
                      : "text-muted-foreground"
              )}
              data-testid="swarm-run-detail-change"
            >
              {change == null
                ? "—"
                : change > 0
                  ? `▲ ${change}`
                  : change < 0
                    ? `▼ ${Math.abs(change)}`
                    : "· 0"}
            </p>
          </div>
        </div>

        <section>
          <h2 className="mb-2 text-sm font-semibold">Goals</h2>
          <ul className="flex flex-col gap-2">
            {wave.runs.map((run) => {
              const runRate =
                run.goalScoreSummary && run.goalScoreSummary.gradedCount > 0
                  ? run.goalScoreSummary.passedCount /
                    run.goalScoreSummary.gradedCount
                  : null;
              return (
                <li
                  key={run.runId}
                  className="flex items-center gap-3 rounded-lg border border-border/60 px-4 py-3"
                  data-testid="swarm-run-detail-journey"
                  data-journey-id={run.journeyRefId}
                  data-run-id={run.runId}
                >
                  <span
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      waveStatusDotClass([run])
                    )}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {run.journeyName}
                    </p>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {run.personaName}
                      {" · "}
                      {run.summary.succeeded}/{run.summary.total} sessions
                      {run.journeyArchived ? " · archived" : ""}
                    </p>
                  </div>
                  <span className="shrink-0 text-sm font-semibold tabular-nums">
                    {runRate != null ? formatPercent(runRate) : "—"}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </ScrollArea>
  );
}

function DetailPersonas({
  wave,
  onOpenPersona,
}: {
  wave: SwarmWave;
  onOpenPersona: (personaName: string) => void;
}) {
  const rows = useMemo(() => {
    const byName = new Map<string, { name: string; journeyCount: number }>();
    for (const run of wave.runs) {
      const existing = byName.get(run.personaName);
      if (existing) existing.journeyCount += 1;
      else byName.set(run.personaName, { name: run.personaName, journeyCount: 1 });
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [wave.runs]);

  return (
    <ScrollArea className="min-h-0 flex-1">
      <ul className="flex flex-col gap-2 px-8 py-5" data-testid="swarm-run-detail-personas">
        {rows.map((row) => (
          <li key={row.name}>
            <button
              type="button"
              className="flex w-full items-center justify-between rounded-lg border border-border/60 px-4 py-3 text-left hover:bg-muted/40"
              onClick={() => onOpenPersona(row.name)}
              data-testid="swarm-run-detail-persona"
            >
              <span className="text-sm font-medium">{row.name}</span>
              <span className="text-[11px] text-muted-foreground">
                {row.journeyCount} goal{row.journeyCount === 1 ? "" : "s"}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </ScrollArea>
  );
}
